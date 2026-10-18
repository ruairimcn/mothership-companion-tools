# Mothership Companion Folders

A Chrome extension that adds a **Folders** drawer to [mothershipcompanion.com](https://mothershipcompanion.com/) so you can group your characters.

## Install (unpacked)

1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `mothership-folders` folder (the one containing `manifest.json`).
4. Open or reload mothershipcompanion.com and sign in.

## Use

- Click the **FOLDERS** tab on the right edge, or press **Alt+F**.
- **+ Folder** creates a folder. ✎ renames, ↑/↓ reorders, ✕ deletes (its characters go back to Unfiled).
- Drag a character onto a folder to file it, or onto another character to place it just above. The **⋯** menu on each character does the same without dragging.
- Click a character's name to open it in the app. This works when the app's character list is on screen.
- **Export / Import** saves and restores your folders as a JSON file.

Folders are stored only in this browser (`chrome.storage.local`). They are not uploaded and won't show in the mobile apps.

## How it works

The app is Flutter web: everything is drawn on a `<canvas>`, so there's no HTML list to rearrange. Instead the extension:

1. **Reads your character list** (`src/hook.js`). The app loads the Firebase SDK and assigns it to `window.firebase_firestore`. The extension intercepts that assignment and wraps the read and write functions, so when the app loads or changes `users/{you}/characters` the extension gets each character's id, name and class. Calls are forwarded unchanged and the extension never writes to Firestore. The list is cached per account so the drawer fills immediately on the next visit.
   If you aren't signed in, it falls back to the app's local cache (`localStorage["flutter.CharacterPool"]`).
2. **Shows its own drawer** (`src/panel.js`, `src/store.js`) in a Shadow DOM over the app.
3. **Opens characters** (`src/opener.js`) by turning on Flutter's accessibility tree (real DOM elements with labels) and clicking the element labelled with the character's name.

## Known limits

- The app's own character list stays flat; folders live in the drawer.
- "Open in app" needs the app's character list visible. If two characters share a name, it opens the first one it finds.
- After the first "open", the app's accessibility layer stays on until you reload. It's harmless but can make the app slightly slower.
- It relies on app internals (the `firebase_firestore` global, Firestore paths, labels). An app update could break it; the drawer would then show "Waiting for the app to load your characters".

## Tests

`node tests/hook.test.mjs` unit-tests the Firestore hook against a fake SDK.
