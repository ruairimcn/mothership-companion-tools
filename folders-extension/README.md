# Mothership Companion Folders

A Chrome extension that adds a **Folders** drawer to [mothershipcompanion.com](https://mothershipcompanion.com/) so you can group your characters, ships and maps.

## Install (unpacked)

1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `mothership-folders` folder (the one containing `manifest.json`).
4. Open or reload mothershipcompanion.com and sign in.

## Update to a new version

1. In the drawer, click **Export** to save a backup of your folders.
2. Unzip the new version (any folder is fine), then in `chrome://extensions` click the reload icon on the extension, or remove it and **Load unpacked** the new folder.
3. If your folders are missing, click **Import** and choose the backup.

From v0.2 the extension has a fixed ID, so later updates keep your folders even if you unzip into a different folder. Upgrading from v0.1 to v0.2 needs the Export/Import step once.

## Use

- Click the **FOLDERS** tab on the right edge, or press **Alt+F**.
- Switch between **Characters**, **Ships** and **Maps** at the top. Each has its own folders.
- **+ Folder** creates a folder. ✎ renames, ↑/↓ reorders, ✕ deletes (its characters go back to Unfiled).
- Drag an item onto a folder to file it, or onto another item to place it just above. The **⋯** menu on each item does the same without dragging.
- Click a name to open it in the app. This works when the matching list (Characters, Ships or Maps) is on screen in the app. If it can't find it, the message has a **Copy details** button; paste the result into a bug report.
- **Export / Import** saves and restores your folders as a JSON file.

Folders are stored only in this browser (`chrome.storage.local`). They are not uploaded and won't show in the mobile apps.

## How it works

The app is Flutter web: everything is drawn on a `<canvas>`, so there's no HTML list to rearrange. Instead the extension:

1. **Reads your lists** (`src/hook.js`). The app loads the Firebase SDK and assigns it to `window.firebase_firestore`. The extension intercepts that assignment and wraps the read and write functions, so when the app loads or changes `users/{you}/characters`, `/ships` or `/maps` the extension gets each item's id, name and subtitle. Calls are forwarded unchanged and the extension never writes to Firestore. Lists are cached per account so the drawer fills immediately on the next visit.
   If you aren't signed in, it reads the app's local caches instead (`flutter.CharacterPool`, `flutter.ShipCubit`, `flutter.MapCubit` in `localStorage`).
   - Characters show their name and class; maps show their title and module.
   - Ships have no single name field, so the drawer shows the ship identifier, or the make and model if that's blank.
2. **Shows its own drawer** (`src/panel.js`, `src/store.js`) in a Shadow DOM over the app.
3. **Opens items** (`src/opener.js`) by turning on Flutter's accessibility tree (real DOM elements with labels) and clicking the element labelled with the item's name.

## Known limits

- The app's own lists stay flat; folders live in the drawer.
- "Open in app" needs the matching list visible in the app. If two items share a name, it opens the first one it finds.
- After the first "open", the app's accessibility layer stays on until you reload. It's harmless but can make the app slightly slower.
- It relies on app internals (the `firebase_firestore` global, Firestore paths, labels). An app update could break it; the drawer would then show "Waiting for the app to load your characters".

## Tests

`node tests/hook.test.mjs` unit-tests the Firestore hook and local-cache reading against a fake SDK.
