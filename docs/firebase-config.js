// ---------------------------------------------------------------------
// Your Firebase web config.
//
// NOTE the `export` keyword below — app.js does
//   import { firebaseConfig } from './firebase-config.js'
// so without it the whole module fails to load and the page sits on
// "Connecting..." forever. The Firebase console gives you this object
// WITHOUT `export`, and with an extra initializeApp() call; keep the
// values, keep the export, and leave the initialising to app.js.
//
// These values are NOT secrets. The Firebase web API key is a project
// identifier, not a credential. Firestore Security Rules plus Google
// sign-in are what protect your data, so committing this publicly is
// expected and fine.
// ---------------------------------------------------------------------

export const firebaseConfig = {
  apiKey: "AIzaSyAwRxKhUsqfZP5RgOiZYBoC-q-ufircY0Y",
  authDomain: "command-deck-2e594.firebaseapp.com",
  projectId: "command-deck-2e594",
  storageBucket: "command-deck-2e594.firebasestorage.app",
  messagingSenderId: "979283514850",
  appId: "1:979283514850:web:67c54002435a94d5f995bb",
  measurementId: "G-YJKJBY3N3J"
};
