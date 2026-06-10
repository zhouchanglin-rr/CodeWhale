//! Public tunnel support for `codewhale remote` / `codewhale serve --remote`.
//!
//! This is the "remote" UX: it runs the existing HTTP/SSE runtime server on
//! loopback, then starts a tunnel process (a Cloudflare quick tunnel by
//! default) that exposes the mobile control page over a public HTTPS URL. The
//! captured URL is printed (with the runtime token pre-attached and an optional
//! QR code) so a phone or tablet can reach the session from any network.
//!
//! A Cloudflare quick tunnel needs no Cloudflare account and provides HTTPS
//! automatically, which also covers the "no TLS" gap of the bare runtime API.
//! Any other tunnel can be supplied via `--tunnel-command`; the first
//! `https://` URL the command prints is treated as the public endpoint.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// How to start the public tunnel and what to print once it is live.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// The program and arguments to run, e.g.
    /// `["cloudflared", "tunnel", "--url", "http://127.0.0.1:7878"]`.
    pub command: Vec<String>,
    /// Runtime bearer token appended to the public URL as `?token=...` so the
    /// phone/tablet is authenticated without typing it in.
    pub token: Option<String>,
    /// Append `/mobile` to the captured public URL (the mobile control page).
    pub mobile_path: bool,
    /// Render a QR code of the public URL in the terminal.
    pub show_qr: bool,
}

/// Build the default Cloudflare quick-tunnel command for a loopback port.
///
/// Quick tunnels (`cloudflared tunnel --url ...`) require no Cloudflare account
/// and terminate TLS at the edge, so the local server can stay on plain HTTP.
pub fn default_cloudflared_command(port: u16) -> Vec<String> {
    vec![
        "cloudflared".to_string(),
        "tunnel".to_string(),
        "--no-autoupdate".to_string(),
        "--url".to_string(),
        format!("http://127.0.0.1:{port}"),
    ]
}

/// Split a `--tunnel-command "..."` string into argv with minimal,
/// shell-like quoting support (single and double quotes, backslash escape).
pub fn parse_tunnel_command(raw: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            has_token = true;
            continue;
        }
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else if ch == '\\' && q == '"' {
                    escaped = true;
                } else {
                    current.push(ch);
                }
            }
            None => match ch {
                '\\' => {
                    escaped = true;
                    has_token = true;
                }
                '\'' | '"' => {
                    quote = Some(ch);
                    has_token = true;
                }
                c if c.is_whitespace() => {
                    if has_token {
                        args.push(std::mem::take(&mut current));
                        has_token = false;
                    }
                }
                c => {
                    current.push(c);
                    has_token = true;
                }
            },
        }
    }
    if has_token {
        args.push(current);
    }
    args
}

/// Extract the first public `https://` URL from a line of tunnel output.
///
/// Tunnel CLIs frame the URL with box-drawing characters, log prefixes, or
/// trailing punctuation; this trims the surrounding noise and returns just the
/// URL. Returns `None` when the line carries no usable URL.
pub fn extract_public_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c.is_control())
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(|c: char| {
        matches!(c, '|' | '"' | '\'' | ')' | ']' | '}' | ',' | '.' | '<' | '>')
    });
    if url.len() > "https://".len() {
        Some(url.to_string())
    } else {
        None
    }
}

/// Build the final URL to hand to the phone: optional `/mobile` path plus the
/// runtime token as a query parameter.
pub fn build_public_mobile_url(base: &str, mobile_path: bool, token: Option<&str>) -> String {
    let mut url = base.trim_end_matches('/').to_string();
    if mobile_path {
        url.push_str("/mobile");
    }
    if let Some(token) = token
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        url.push_str("?token=");
        url.push_str(&percent_encode(token));
    }
    url
}

/// Percent-encode a token for safe inclusion in a URL query component.
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                use std::fmt::Write as _;
                let _ = write!(encoded, "%{byte:02X}");
            }
        }
    }
    encoded
}

/// Spawn the tunnel as a detached background task. The task owns the child
/// process and prints the public URL once it appears in the tunnel's output.
pub fn spawn_tunnel(config: TunnelConfig) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(err) = run_tunnel(config).await {
            eprintln!("Remote tunnel error: {err}");
        }
    })
}

async fn run_tunnel(config: TunnelConfig) -> anyhow::Result<()> {
    let program = match config.command.first() {
        Some(program) if !program.trim().is_empty() => program.clone(),
        _ => {
            eprintln!("Remote tunnel: no tunnel command configured; skipping.");
            return Ok(());
        }
    };

    let mut command = Command::new(&program);
    command
        .args(&config.command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    println!(
        "Remote tunnel: starting `{}` (waiting for a public URL)...",
        config.command.join(" ")
    );

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            print_missing_tunnel_hint(&program);
            return Ok(());
        }
        Err(err) => {
            return Err(anyhow::anyhow!("failed to start tunnel `{program}`: {err}"));
        }
    };

    // cloudflared prints its banner to stderr; other CLIs may use stdout. Read
    // both, funnel lines into a single channel, and stop scanning once the URL
    // is found (but keep the child alive for the life of the server).
    let (tx, mut rx) = mpsc::channel::<String>(128);
    if let Some(stdout) = child.stdout.take() {
        spawn_line_pump(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_line_pump(stderr, tx.clone());
    }
    drop(tx);

    let mut announced = false;
    while let Some(line) = rx.recv().await {
        if announced {
            continue;
        }
        if let Some(public) = extract_public_url(&line) {
            let url = build_public_mobile_url(&public, config.mobile_path, config.token.as_deref());
            print_remote_ready(&url, config.show_qr);
            announced = true;
        }
    }

    let status = child.wait().await;
    if !announced {
        eprintln!(
            "Remote tunnel exited before a public URL was detected{}.",
            match status {
                Ok(status) => format!(" (status: {status})"),
                Err(err) => format!(" ({err})"),
            }
        );
    }
    Ok(())
}

fn spawn_line_pump<R>(reader: R, tx: mpsc::Sender<String>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });
}

fn print_remote_ready(url: &str, show_qr: bool) {
    println!("\nRemote access ready. Open this on your phone or tablet (any network):");
    println!("  {url}");
    println!(
        "Remote security: this URL is public. The runtime token in it is the only guard, so \
         treat the link like a password and stop the server to revoke access."
    );
    if show_qr {
        match qrcode::QrCode::new(url.as_bytes()) {
            Ok(qr) => {
                let rendered = qr.render::<qrcode::render::unicode::Dense1x2>().build();
                println!("\n{rendered}");
            }
            Err(err) => eprintln!("Warning: could not generate QR code: {err}"),
        }
    }
}

fn print_missing_tunnel_hint(program: &str) {
    eprintln!("Remote tunnel: `{program}` was not found on PATH.");
    if program == "cloudflared" {
        eprintln!(
            "  Install cloudflared to enable the default Cloudflare quick tunnel:\n\
             \x20   macOS:   brew install cloudflared\n\
             \x20   Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n\
             \x20   Windows: winget install --id Cloudflare.cloudflared"
        );
        eprintln!(
            "  Or point --tunnel-command at another tunnel (e.g. ngrok, tailscale funnel, bore)."
        );
    } else {
        eprintln!("  Check that the command in --tunnel-command is installed and on PATH.");
    }
    eprintln!("  The local runtime server is still running; only public access is unavailable.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_command_targets_loopback_port() {
        let cmd = default_cloudflared_command(7878);
        assert_eq!(cmd.first().map(String::as_str), Some("cloudflared"));
        assert!(cmd.iter().any(|arg| arg == "http://127.0.0.1:7878"));
        assert!(cmd.iter().any(|arg| arg == "--url"));
    }

    #[test]
    fn parse_tunnel_command_splits_on_whitespace() {
        assert_eq!(
            parse_tunnel_command("ngrok http 7878"),
            vec!["ngrok", "http", "7878"]
        );
    }

    #[test]
    fn parse_tunnel_command_respects_quotes() {
        assert_eq!(
            parse_tunnel_command("sh -c 'echo https://x.example'"),
            vec!["sh", "-c", "echo https://x.example"]
        );
        assert_eq!(
            parse_tunnel_command("cmd \"a b\" c"),
            vec!["cmd", "a b", "c"]
        );
    }

    #[test]
    fn parse_tunnel_command_handles_empty() {
        assert!(parse_tunnel_command("   ").is_empty());
    }

    #[test]
    fn extract_public_url_from_cloudflare_banner() {
        let line = "2024-01-01T00:00:00Z INF |  https://random-words-1234.trycloudflare.com  |";
        assert_eq!(
            extract_public_url(line).as_deref(),
            Some("https://random-words-1234.trycloudflare.com")
        );
    }

    #[test]
    fn extract_public_url_trims_trailing_punctuation() {
        assert_eq!(
            extract_public_url("Visit https://abc.example.com.").as_deref(),
            Some("https://abc.example.com")
        );
        assert_eq!(
            extract_public_url("url=(https://abc.example.com)").as_deref(),
            Some("https://abc.example.com")
        );
    }

    #[test]
    fn extract_public_url_ignores_plain_http_and_noise() {
        assert!(extract_public_url("http://127.0.0.1:7878/mobile").is_none());
        assert!(extract_public_url("no url on this line").is_none());
        assert!(extract_public_url("https://").is_none());
    }

    #[test]
    fn build_public_mobile_url_adds_path_and_token() {
        assert_eq!(
            build_public_mobile_url("https://x.trycloudflare.com", true, Some("tok en")),
            "https://x.trycloudflare.com/mobile?token=tok%20en"
        );
    }

    #[test]
    fn build_public_mobile_url_without_token_or_path() {
        assert_eq!(
            build_public_mobile_url("https://x.trycloudflare.com/", false, None),
            "https://x.trycloudflare.com"
        );
        assert_eq!(
            build_public_mobile_url("https://x.trycloudflare.com", false, Some("  ")),
            "https://x.trycloudflare.com"
        );
    }
}
