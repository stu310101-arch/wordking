# Firebase Web SDK 12.19.0

These browser modules are from the official Firebase CDN:

- https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js
- https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js
- https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js

The only transformations are replacing the CDN import of `firebase-app.js` with
`./firebase-app.js`, and removing the unavailable source map comment. Original
copyright and license notices are retained. See `LICENSE` and the source notices
for bundled third-party licenses.

`config/firebase-vendor-lock.json` records original and transformed SHA-256 hashes,
byte lengths and source URLs. `npm run verify:runtime --prefix config` verifies the
shipped files and checks that their static module graph remains local.

The version is pinned so the complete, reviewed runtime is available without a
network connection. Version 12.19.0 includes the Safari/iOS popup persistence fixes
and earlier FirebaseError template processing security fix described in the
[official release notes](https://firebase.google.com/support/release-notes/js).

When updating, download an explicitly selected official version, review its release
notes, reproduce these two transformations, update the lock and versioned directory,
and change `assets/app.js` and `sw.js` together. Bump the PWA release, then run the
runtime, application, emulator and real-browser tests before deploying. Do not edit
minified runtime code to suppress security checks or bypass authentication.
