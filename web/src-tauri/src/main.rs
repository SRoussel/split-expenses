// Split Insights as a desktop app. It starts the split-insights server (the same one
// `uv run split-insights` runs) on a free local port, shows its page in a window, and
// stops the server when the window closes. The page and the data stay on this computer.
//
// SPLIT_DIR is the repo folder with your transaction files; by default, the folder this
// app was built in.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// The server process, so it can be stopped on the way out.
struct Server(Mutex<Option<Child>>);

fn repo_dir() -> PathBuf {
    std::env::var_os("SPLIT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

/// How to start the server. The project's own virtualenv first: started directly, it stops
/// cleanly with the app. Otherwise through uv, which apps opened from a menu may not find
/// on PATH, so look in the usual places.
fn server_command(dir: &Path) -> Command {
    let venv = if cfg!(windows) {
        dir.join(".venv/Scripts/split-insights.exe")
    } else {
        dir.join(".venv/bin/split-insights")
    };
    if venv.exists() {
        return Command::new(venv);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let uv = [home.join(".local/bin/uv"), home.join(".cargo/bin/uv")]
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| "uv".into());
    let mut cmd = Command::new(uv);
    cmd.args(["run", "split-insights"]);
    cmd
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8765)
}

/// Shows a message on the loading page, for when the server can't start.
fn show_problem(window: &tauri::WebviewWindow, message: &str) {
    let text = format!("{message:?}"); // a quoted string JavaScript can read
    let _ = window.eval(&format!("document.getElementById('status').textContent = {text}"));
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Split Insights")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .build()?;

            let dir = repo_dir();
            let port = free_port();
            let started = server_command(&dir)
                .current_dir(&dir)
                .args(["--no-open", "--port", &port.to_string()])
                .stdin(Stdio::null())
                .spawn();
            let child = match started {
                Ok(child) => child,
                Err(e) => {
                    show_problem(&window, &format!("Couldn't start split-insights in {}: {e}", dir.display()));
                    return Ok(());
                }
            };
            *app.state::<Server>().0.lock().unwrap() = Some(child);

            // Wait for the server in the background, then show its page.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(60);
                loop {
                    if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                        let url = Url::parse(&format!("http://127.0.0.1:{port}/?app")).unwrap();
                        let _ = window.navigate(url);
                        return;
                    }
                    let exited = handle
                        .state::<Server>()
                        .0
                        .lock()
                        .unwrap()
                        .as_mut()
                        .and_then(|c| c.try_wait().ok().flatten());
                    if let Some(status) = exited {
                        show_problem(
                            &window,
                            &format!("split-insights stopped ({status}). Try `uv run split-insights` in a terminal to see why."),
                        );
                        return;
                    }
                    if Instant::now() > deadline {
                        show_problem(&window, "split-insights didn't start within a minute.");
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("couldn't start the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
