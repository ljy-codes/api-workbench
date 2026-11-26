#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    if let Err(error) = api_workbench_lib::run() {
        eprintln!("{error}");
    }
}
