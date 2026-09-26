//! Native menu bar. Each custom item's id is forwarded to the UI as a `floe://menu` event
//! (handled by `onNativeMenu` in js/ui/app.js). Clipboard / window items use the OS-native roles.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

fn item<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, true, accel)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);

    let file = Submenu::with_items(app, "File", true, &[
        &item(app, "file.new", "New Project", Some("CmdOrCtrl+N"))?,
        &item(app, "file.open", "Open Project…", Some("CmdOrCtrl+O"))?,
        &sep()?,
        &item(app, "file.save", "Save", Some("CmdOrCtrl+S"))?,
        &item(app, "file.save_as", "Save As…", Some("CmdOrCtrl+Shift+S"))?,
        &sep()?,
        &item(app, "file.get_data", "Get Data from File…", Some("CmdOrCtrl+Shift+O"))?,
        &item(app, "file.folder", "Combine Folder…", None)?,
        &item(app, "file.samples", "Load Sample Project", None)?,
        &sep()?,
        &item(app, "file.export_xlsx", "Export Query to Excel…", Some("CmdOrCtrl+E"))?,
        &item(app, "file.export_csv", "Export Query to CSV…", None)?,
        &item(app, "file.export_python", "Export to Polars Python…", None)?,
    ])?;
    #[cfg(not(target_os = "macos"))]
    {
        file.append(&sep()?)?;
        file.append(&item(app, "file.settings", "Settings…", Some("Ctrl+,"))?)?;
        file.append(&sep()?)?;
        file.append(&PredefinedMenuItem::quit(app, Some("Quit Floe"))?)?;
    }

    // Undo/Redo drive the project history; Cut/Copy/Paste stay native so text fields behave normally.
    let edit = Submenu::with_items(app, "Edit", true, &[
        &item(app, "edit.undo", "Undo Step", Some("CmdOrCtrl+Z"))?,
        &item(app, "edit.redo", "Redo Step", Some("CmdOrCtrl+Shift+Z"))?,
        &sep()?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;

    let query = Submenu::with_items(app, "Query", true, &[
        &item(app, "query.refresh", "Refresh", Some("F5"))?,
        &item(app, "query.refresh_all", "Refresh All Outputs", Some("CmdOrCtrl+F5"))?,
        &sep()?,
        &item(app, "query.preview", "Evaluate on Preview Sample", None)?,
        &item(app, "query.full", "Evaluate on Full Data", Some("CmdOrCtrl+Shift+F"))?,
        &sep()?,
        &item(app, "query.params", "Parameters…", None)?,
        &item(app, "query.deps", "Query Dependencies…", None)?,
        &item(app, "query.project_files", "Project File (git view)…", None)?,
        &item(app, "query.cli", "Run Headless (CLI)…", None)?,
    ])?;

    let view = Submenu::with_items(app, "View", true, &[
        &item(app, "view.theme", "Toggle Polar Night", Some("CmdOrCtrl+Shift+L"))?,
        &sep()?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;

    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
        &sep()?,
        &PredefinedMenuItem::close_window(app, None)?,
    ])?;

    let help = Submenu::with_items(app, "Help", true, &[
        &item(app, "help.shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?,
        &item(app, "help.about", "About Floe", None)?,
    ])?;

    #[cfg(target_os = "macos")]
    {
        let about = AboutMetadata { name: Some("Floe".into()), version: Some(app.package_info().version.to_string()), comments: Some("Polars desktop".into()), ..Default::default() };
        let app_menu = Submenu::with_items(app, "Floe", true, &[
            &PredefinedMenuItem::about(app, Some("About Floe"), Some(about))?,
            &sep()?,
            &item(app, "file.settings", "Settings…", Some("Cmd+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ])?;
        return Menu::with_items(app, &[&app_menu, &file, &edit, &query, &view, &window, &help]);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = AboutMetadata::default();
        Menu::with_items(app, &[&file, &edit, &query, &view, &window, &help])
    }
}
