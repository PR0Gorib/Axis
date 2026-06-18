/**
 * tauri-close-guard.js
 * Drop in src/ alongside index.html.
 *
 * How the close flow works:
 *   1. User clicks X  →  onCloseRequested fires, closeConfirmed=false
 *   2. We call event.preventDefault() to block the close
 *   3. We show the warning modal
 *   4a. User clicks Cancel / Export first  →  nothing, app stays open
 *   4b. User clicks "Close anyway"  →  set closeConfirmed=true, call appWindow.close()
 *   5. onCloseRequested fires again, this time closeConfirmed=true → we return early
 *      and the window actually closes (no more preventDefault)
 *
 * Accesses globals from the main CTool <script> directly (no window. prefix)
 * because they are `let` / `function` declarations, not window properties.
 */

(function initTauriCloseGuard() {
  if (!window.__TAURI__?.window) return;

  const appWindow = window.__TAURI__.window.getCurrentWindow();
  let closeConfirmed = false;

  appWindow.onCloseRequested(async (event) => {
    // If user already confirmed, or nothing to lose → let it close normally
    if (closeConfirmed || !incognitoMode || items.length === 0) return;

    // Block the close and show our modal
    event.preventDefault();

    const shouldClose = await showCloseWarning();
    if (shouldClose) {
      closeConfirmed = true;
      appWindow.close(); // re-triggers onCloseRequested; this time closeConfirmed=true so it passes through
    }
  });
})();

function showCloseWarning() {
  return new Promise(resolve => {
    const count = items.length;

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,.85)',
      'z-index:9999', 'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    overlay.innerHTML = `
      <div style="
        background:#16161a; border:1px solid #e84a4a; border-radius:6px;
        padding:28px 32px; max-width:380px; width:90%;
        font-family:'Barlow Condensed',sans-serif;
      ">
        <div style="
          font-size:1.4rem; font-weight:900; letter-spacing:.06em;
          text-transform:uppercase; color:#e84a4a; margin-bottom:10px;
        ">⚠ Incognito — Unsaved Data</div>

        <div style="
          font-size:.92rem; color:#9090a0; line-height:1.6;
          font-family:'Barlow',sans-serif; margin-bottom:22px;
        ">
          You have
          <strong style="color:#e8e8ec">${count} item${count !== 1 ? 's' : ''}</strong>
          in incognito mode that will be permanently lost when the app closes.
          <br><br>
          Export your data before closing, or close anyway.
        </div>

        <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap;">
          <button id="cwb-export" style="
            font-family:'Barlow Condensed',sans-serif; font-weight:700;
            font-size:.82rem; letter-spacing:.06em; text-transform:uppercase;
            padding:8px 16px; border:1.5px solid #4ae8c9;
            background:transparent; color:#4ae8c9; cursor:pointer; border-radius:3px;
          ">⬇ Export first</button>
          <button id="cwb-cancel" style="
            font-family:'Barlow Condensed',sans-serif; font-weight:700;
            font-size:.82rem; letter-spacing:.06em; text-transform:uppercase;
            padding:8px 16px; border:1.5px solid #2a2a32;
            background:transparent; color:#e8e8ec; cursor:pointer; border-radius:3px;
          ">Cancel</button>
          <button id="cwb-close" style="
            font-family:'Barlow Condensed',sans-serif; font-weight:700;
            font-size:.82rem; letter-spacing:.06em; text-transform:uppercase;
            padding:8px 16px; border:1.5px solid #e84a4a;
            background:transparent; color:#e84a4a; cursor:pointer; border-radius:3px;
          ">Close anyway</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#cwb-export').onclick = () => {
      exportJSON();
      document.body.removeChild(overlay);
      resolve(false); // keep app open
    };
    overlay.querySelector('#cwb-cancel').onclick = () => {
      document.body.removeChild(overlay);
      resolve(false); // keep app open
    };
    overlay.querySelector('#cwb-close').onclick = () => {
      document.body.removeChild(overlay);
      resolve(true); // close the app
    };
  });
}
