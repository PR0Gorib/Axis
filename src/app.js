    // ── STATE ──────────────────────────────────────────
    let items = [];
    let categories = [];
    let activeProject = { id: null, name: '' }; // currently open project — kept in sync with storage.js
    let currentSort = { cat: 'overall', dir: 'desc' };
    let searchQuery = '';
    let compareSet = new Set(); // ids selected for compare
    let bulkEditMode = false;
    let bulkEditSet = new Set(); // ids selected for bulk stat editing — no size cap unlike compareSet
    let editingId = null;
    let pendingImages = [];   // unified image list — index 0 is always primary
    let pendingTags = [];   // tags being edited in modal
    let activeTagFilter = ''; // currently active tag filter
    let lastDeleted = null;  // { item, index } for undo
    let lightMode = false;
    let statMax = 10;
    let _panelImgs = [];     // images array for current open panel
    let _panelImgIdx = 0;      // current carousel index
    let scoreFilterMin = 0;    // score range filter
    let scoreFilterMax = 10;   // updated to statMax on toggle

    // ── PERSISTENCE ────────────────────────────────────
    let incognitoMode = false;

    // ── VERSION / UPDATE CHECK ──────────────────────────
    // Keep this in sync with the version shown in the Settings > About panel
    // and with the tag of the most recent GitHub release.
    const APP_VERSION = '1.7.1';
    const UPDATE_REPO = 'PR0Gorib/Axis';
    let updateDismissed = false; // don't re-show the banner after the user closes it, for this session

    // ── STORAGE SHIMS ──────────────────────────────────
    // These bridge the stub names used throughout the file
    // to the AxisStorage API defined in storage.js

    let _backedUpProjectIds = new Set(); // which projects have had their session-start backup this session

    async function axisInit() {
      await AxisStorage.init();
      await AxisStorage.migrateFromLocalStorage();
    }

    async function axisLoad() {
      // Try primary storage (Tauri disk) first
      try {
        const data = await AxisStorage.loadData();
        if (data && (data.items.length || data.categories.length)) return data;
      } catch (e) { console.error('[Axis] loadData failed:', e); }
      // Fallback: localStorage (covers browser mode + Tauri disk failures)
      try {
        const raw = localStorage.getItem('axis');
        if (raw) {
          const d = JSON.parse(raw);
          if (d?.items || d?.categories) {
            return { items: d.items || [], categories: d.categories || [], statMax: d.statMax };
          }
        }
      } catch (e) { }
      return { items: [], categories: [], statMax: undefined };
    }

    // Thin load() wrapper — used by toggleIncognito to restore data
    async function load() {
      const data = await axisLoad();
      items = data.items;
      categories = data.categories;
      // statMax is per-project — see the STAT MAX TOGGLE section below for
      // the same undefined-means-inherit-legacy-default fallback used here.
      statMax = data.statMax ?? statMax;
      scoreFilterMax = statMax;
    }

    async function axisSave(itemsArr, catsArr) {
      // First save of THIS project this session → snapshot whatever's
      // currently on disk BEFORE we overwrite it. Tracked per-project (not
      // globally) so switching to a different project mid-session still
      // gets its own first-change safety backup, exactly like it would if
      // it were the only project you ever opened. Awaited so it can never
      // race with saveData() writing new image files to the same paths.
      if (!_backedUpProjectIds.has(activeProject.id) && AxisStorage.isTauri) {
        _backedUpProjectIds.add(activeProject.id);
        try { await AxisStorage.createBackup(); } catch (e) { console.error('[Axis] backup failed:', e); }
      }
      try {
        await AxisStorage.saveData(itemsArr, catsArr, statMax);
      } catch (e) {
        // Disk write failed → fall back to localStorage so data is never lost
        try { localStorage.setItem('axis', JSON.stringify({ items: itemsArr, categories: catsArr, statMax })); } catch (_) { }
        console.error('[Axis] saveData failed, fell back to localStorage:', e);
      }
      // !! Do NOT mutate itemsArr here — items keep base64 in memory for display.
      // Only the serialised copy written to disk uses filename refs.
      return itemsArr;
    }

    async function axisLoadSettings() {
      return AxisStorage.loadSettings();
    }

    // Partial update — caller passes only the keys that changed. statMax is
    // still included here even though it's now per-project (saved via
    // axisSave, not this function) — see storage.js's saveSettings() doc:
    // it's written as a LEGACY value only, read back once by the migration
    // path in the init sequence above for projects that predate the
    // per-project change, and otherwise ignored.
    async function axisSaveSettings(partial) {
      const current = {
        theme: lightMode ? 'light' : 'dark',
        statMax: statMax,
        viewMode: viewMode,
      };
      AxisStorage.saveSettings({ ...current, ...partial }).catch(() => { });
    }

    // ── PROJECTS ─────────────────────────────────────────
    // A "project" is a separate, independently-saved comparison list (its
    // own items, categories, images, backups) — e.g. "Games", "Movies",
    // "Restaurants". Exactly one is active at a time; switching repoints
    // storage.js at the new one and reloads items/categories into memory.
    // Theme, view mode, templates, and incognito stay global across every
    // project, by design. The stat scale (statMax) does NOT — it's
    // per-project, reloaded alongside items/categories on every switch.

    // Refreshes the cached { id, name } for whichever project is currently
    // active. Call after init and after any create/rename/switch/delete.
    async function axisRefreshActiveProject() {
      try {
        const { activeProjectId, projects } = await AxisStorage.listProjects();
        const found = projects.find(p => p.id === activeProjectId);
        activeProject = found ? { id: found.id, name: found.name } : { id: activeProjectId, name: '' };
      } catch (e) {
        console.error('[Axis] axisRefreshActiveProject failed:', e);
      }
      _updateHeaderProjectName();
    }

    async function axisListProjects() {
      try { return await AxisStorage.listProjects(); }
      catch (e) { console.error('[Axis] axisListProjects failed:', e); return { activeProjectId: null, projects: [] }; }
    }

    // Clears everything that's meaningful only within the PREVIOUS project's
    // item set — stale selections, search text, filters, sort, and any open
    // panel/modal — so nothing from one project bleeds into another. Global
    // preferences (theme, viewMode, incognito, templates) are deliberately
    // left untouched. statMax is NOT global — it's reset by the caller
    // (_loadActiveProjectIntoMemory) before this runs, since it's part of
    // the project being switched to, not a shared app preference.
    function _resetProjectScopedUIState() {
      compareSet.clear();
      renderCompareBar();
      if (bulkEditMode) exitBulkEditMode();

      searchQuery = '';
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';

      activeTagFilter = '';
      currentSort = { cat: 'overall', dir: 'desc' };

      scoreFilterMin = 0;
      scoreFilterMax = statMax;
      updateScoreFilterInputs();

      closePanel();
      closeModal();
    }

    // Loads whatever project is active in storage.js into memory and
    // refreshes the UI. Shared by switch/create/delete below so they all
    // end up in the exact same consistent state.
    async function _loadActiveProjectIntoMemory() {
      const loaded = await axisLoad();
      items = loaded.items;
      categories = loaded.categories;
      // statMax is per-project. Projects created before this feature
      // existed have no statMax of their own — rather than silently
      // resetting those to the app default (10) every time you switch to
      // them, keep whatever scale was active a moment ago. Projects that
      // DO have a saved statMax (including ones you've since changed the
      // scale on) always use their own value.
      statMax = loaded.statMax ?? statMax;
      const statBtn = document.getElementById('stat-max-btn');
      if (statBtn) statBtn.textContent = `Max Stat: ${statMax}`;
      await axisRefreshActiveProject();
      _resetProjectScopedUIState();
      render();
    }

    // Creates a new empty project and switches to it immediately — matches
    // the expected "+ New Project" UX (you create one because you want to
    // start using it, not to leave it sitting inactive).
    async function axisCreateProject(name) {
      const project = await AxisStorage.createProject(name);
      if (!project) { showToast('Could not create the project.', true); return null; }
      const switched = await AxisStorage.setActiveProject(project.id);
      if (!switched) { showToast('Project created, but could not switch to it.', true); return project; }
      await _loadActiveProjectIntoMemory();
      showToast(`Switched to "${project.name}".`);
      return project;
    }

    async function axisSwitchProject(id) {
      if (id === activeProject.id) return true; // already active, nothing to do
      const ok = await AxisStorage.setActiveProject(id);
      if (!ok) { showToast('Could not switch projects.', true); return false; }
      await _loadActiveProjectIntoMemory();
      showToast(`Switched to "${activeProject.name}".`);
      return true;
    }

    async function axisRenameProject(id, newName) {
      const ok = await AxisStorage.renameProject(id, newName);
      if (!ok) { showToast('Could not rename the project.', true); return false; }
      if (id === activeProject.id) await axisRefreshActiveProject();
      showToast('Project renamed.');
      return true;
    }

    // Deletes a project outright — its data, images, and backups are gone,
    // not just hidden. If the deleted project was the active one, storage.js
    // has already switched to whatever project is now first in line; we
    // just need to load that project's data into memory here.
    async function axisDeleteProject(id) {
      const result = await AxisStorage.deleteProject(id);
      if (!result.ok) {
        const msg = result.reason === 'last-project'
          ? "Can't delete your only project — create another one first."
          : 'Could not delete the project.';
        showToast(msg, true);
        return result;
      }
      if (result.newActiveId) {
        await _loadActiveProjectIntoMemory();
      }
      showToast('Project deleted.');
      return result;
    }

    async function axisExportJSON(itemsArr, catsArr) {
      const filename = await AxisStorage.exportJSON(itemsArr, catsArr);
      return filename ? `Exported → ${filename}` : null; // null = cancelled
    }

    async function axisExportZip(itemsArr, catsArr) {
      const filename = await AxisStorage.exportZip(itemsArr, catsArr);
      return filename ? `Exported → ${filename}` : null;
    }

    async function axisExportXLSX(itemsArr, catsArr) {
      const filename = await AxisStorage.exportXLSX(itemsArr, catsArr);
      return filename ? `Exported → ${filename}` : null;
    }

    /**
     * Parse a File object selected via <input type="file">.
     * Handles .json, .zip, and .xlsx. Returns { items, categories }.
     */
    async function axisParseImport(file) {
      const nameLower = file.name.toLowerCase();
      if (nameLower.endsWith('.zip')) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let entries = AxisStorage.parseZip(bytes);
        entries = await AxisStorage.decompressZip(entries);

        let data = null;
        const imageMap = {}; // filename → Uint8Array

        for (const entry of entries) {
          if (entry.name === 'data.json') {
            const text = new TextDecoder().decode(entry.data);
            const d = JSON.parse(text);
            data = {
              items: d.items || (Array.isArray(d) ? d : []),
              categories: d.categories || [],
            };
          } else if (entry.name.startsWith('images/') && entry.data?.length) {
            const fname = entry.name.replace('images/', '');
            imageMap[fname] = entry.data;
          }
        }

        if (!data) throw new Error('No data.json found in ZIP');

        // Resolve image refs (img / img2 / img3): prefer writing to disk (Tauri)
        // or fall back to in-memory base64
        async function resolveField(item, field) {
          const ref = item[field];
          if (!ref || ref.startsWith('data:')) return;
          const imgData = imageMap[ref];
          if (!imgData) return;

          let binary = '';
          for (let i = 0; i < imgData.length; i++) binary += String.fromCharCode(imgData[i]);
          const dataUrl = 'data:image/jpeg;base64,' + btoa(binary);

          if (AxisStorage.isTauri) {
            const filename = await AxisStorage.saveImage(dataUrl, item.id + '_' + (field === 'img' ? '1' : field === 'img2' ? '2' : field === 'img3' ? '3' : field === 'img4' ? '4' : '5'));
            item[field] = await AxisStorage.loadImage(filename) || dataUrl;
          } else {
            item[field] = dataUrl;
          }
        }

        await Promise.all(data.items.map(item => Promise.all([
          resolveField(item, 'img'),
          resolveField(item, 'img2'),
          resolveField(item, 'img3'),
          resolveField(item, 'img4'),
          resolveField(item, 'img5'),
        ])));

        return data;
      } else if (nameLower.endsWith('.xlsx')) {
        const buffer = await file.arrayBuffer();
        return _parseXLSXImport(buffer);
      } else {
        // Plain JSON — handle { items, categories } and legacy plain-array formats
        const text = await file.text();
        const d = JSON.parse(text);
        let items = d.items ?? (Array.isArray(d) ? d : null);
        let categories = d.categories ?? [];
        if (!items) throw new Error('Unrecognised JSON format — no items array found');
        // Items may have base64 images (old format) or filename refs (new format).
        // For filename refs without Tauri disk access, clear the image so it
        // doesn't show a broken <img src="img_abc.jpg"> reference.
        if (!AxisStorage.isTauri) {
          items = items.map(item => ({
            ...item,
            img: item.img?.startsWith('data:') ? item.img : '',
            img2: item.img2?.startsWith('data:') ? item.img2 : '',
            img3: item.img3?.startsWith('data:') ? item.img3 : '',
          }));
        }
        return { items, categories };
      }
    }

    // ── XLSX IMPORT ────────────────────────────────────────
    // Two-sheet workbook: "Items" (Name, Bio, Tags, Pinned, one column per
    // category) and "Categories" (Category, Type — Type is reserved for
    // future category kinds beyond plain numeric stats, defaulting to
    // "Number" today). Building both sheets means categories round-trip
    // with their own identity instead of being inferred from leftover
    // columns, which is more reliable than the old CSV importer's guesswork.
    function _parseXLSXImport(buffer) {
      const wb = XLSX.read(buffer, { type: 'array' });

      const itemsSheetName = wb.SheetNames.find(n => n.toLowerCase() === 'items') || wb.SheetNames[0];
      const catsSheetName  = wb.SheetNames.find(n => n.toLowerCase() === 'categories');
      if (!itemsSheetName) throw new Error('No sheets found in workbook');

      const itemRows = XLSX.utils.sheet_to_json(wb.Sheets[itemsSheetName], { defval: '' });
      if (!itemRows.length) throw new Error('Items sheet has no data rows');

      // Prefer the explicit Categories sheet for the category list (and
      // future type info); fall back to inferring from Items columns if
      // that sheet is missing, same spirit as the old CSV importer.
      let categories;
      if (catsSheetName) {
        const catRows = XLSX.utils.sheet_to_json(wb.Sheets[catsSheetName], { defval: '' });
        categories = catRows
          .map(r => String(r.Category || r.category || '').trim())
          .filter(Boolean);
      }
      if (!categories || !categories.length) {
        const reserved = ['name', 'bio', 'notes', 'description', 'tags', 'pinned'];
        categories = Object.keys(itemRows[0]).filter(h => !reserved.includes(h.toLowerCase()));
      }

      const items = itemRows.map((row, i) => {
        const keys = Object.keys(row);
        const nameKey = keys.find(k => k.toLowerCase() === 'name') || keys[0];
        const bioKey  = keys.find(k => ['bio', 'notes', 'description'].includes(k.toLowerCase()));
        const tagsKey = keys.find(k => k.toLowerCase() === 'tags');
        const pinKey  = keys.find(k => k.toLowerCase() === 'pinned');

        const name = String(row[nameKey] ?? '').trim();
        const stats = {};
        categories.forEach(cat => {
          const raw = parseFloat(row[cat]);
          stats[cat] = isNaN(raw) ? 0 : Math.min(statMax, Math.max(0, raw));
        });
        const tags = tagsKey && row[tagsKey]
          ? String(row[tagsKey]).split(',').map(t => t.trim()).filter(Boolean)
          : [];
        const bio = bioKey ? String(row[bioKey] || '').trim() : '';
        const pinned = pinKey ? /^(true|yes|1)$/i.test(String(row[pinKey]).trim()) : false;

        return {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + i,
          name, stats, tags, bio, pinned,
          img: '', img2: '', img3: '', img4: '', img5: '',
          createdAt: Date.now(),
        };
      }).filter(item => item.name); // skip malformed/blank rows rather than failing the whole import

      if (!items.length) throw new Error('No valid rows found in Items sheet');
      return { items, categories };
    }



    function save() {
      if (incognitoMode) return;
      // Fire-and-forget — updates localStorage immediately, writes file in background
      axisSave(items, categories).then(migrated => {
        if (migrated !== items) {
          // Images were migrated from base64 to files — update in place quietly
          migrated.forEach((m, i) => { if (items[i]) items[i].img = m.img; });
        }
      }).catch(e => console.error('[Axis] save error:', e));
    }
    // load() is replaced by axisLoad() called in the async init block below

    function toggleIncognito() {
      incognitoMode = !incognitoMode;
      document.body.classList.toggle('incognito', incognitoMode);
      // sync drawer switch + header badge
      const switchEl = document.getElementById('ham-switch');
      const headerBadge = document.getElementById('incognito-badge');
      const toggleBtn = document.getElementById('ham-incognito-btn');
      if (switchEl) switchEl.classList.toggle('on', incognitoMode);
      if (headerBadge) headerBadge.classList.toggle('visible', incognitoMode);
      if (toggleBtn) toggleBtn.setAttribute('aria-checked', String(incognitoMode));
      if (incognitoMode) {
        // stash current data, start fresh in memory
        items = []; categories = [];
        scoreFilterMin = 0;
        scoreFilterMax = statMax;
        closeInsightsPanel();
        closeScoreFilterPanel();
        render();
        showToast('Incognito on — nothing will be saved.');
      } else {
        // restore from disk / localStorage
        load().then(() => { render(); showToast('Incognito off — your saved data is restored.'); });
      }
    }

    // Warn before closing when in incognito with unsaved data
    window.addEventListener('beforeunload', e => {
      if (incognitoMode && items.length > 0) {
        e.preventDefault();
        e.returnValue = 'You are in incognito mode — all data will be lost. Export first?';
        return e.returnValue;
      }
    });

    // ── TOAST ──────────────────────────────────────────
    let toastTimer;
    function showToast(msg, isError = false) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'show' + (isError ? ' error' : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.className = ''; }, 3000);
    }

    // ── UPDATE CHECK ─────────────────────────────────────
    // Compares two 'x.y.z' version strings (an optional leading 'v' and any
    // trailing '-beta'/'+build' style suffix are ignored). Returns 1 if a > b,
    // -1 if a < b, 0 if equal. Missing/non-numeric parts are treated as 0.
    function compareVersions(a, b) {
      const clean = v => String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
      const pa = clean(a).split('.').map(n => parseInt(n, 10) || 0);
      const pb = clean(b).split('.').map(n => parseInt(n, 10) || 0);
      const len = Math.max(pa.length, pb.length);
      for (let i = 0; i < len; i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (na !== nb) return na > nb ? 1 : -1;
      }
      return 0;
    }

    // manual=true → called from the Settings button, so always show a toast
    // result (found / up to date / error). manual=false → silent startup
    // check, only surfaces anything when a newer release actually exists.
    async function checkForUpdates(manual = false) {
      const statusEl = document.getElementById('update-check-status');
      const btnEl    = document.getElementById('update-check-btn');
      if (manual && btnEl) { btnEl.disabled = true; btnEl.textContent = 'Checking…'; }
      if (manual && statusEl) { statusEl.textContent = 'Checking for updates…'; statusEl.classList.remove('update-available'); }

      try {
        const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
          headers: { 'Accept': 'application/vnd.github+json' }
        });
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        const data = await res.json();
        const latestTag = data.tag_name || data.name || '';
        const releaseUrl = data.html_url || `https://github.com/${UPDATE_REPO}/releases`;

        if (compareVersions(latestTag, APP_VERSION) > 0) {
          showUpdateBanner(latestTag, releaseUrl);
          if (statusEl) {
            statusEl.textContent = `Version ${latestTag.replace(/^v/i, '')} is available.`;
            statusEl.classList.add('update-available');
          }
          if (manual) showToast(`Update available: ${latestTag}`);
        } else {
          if (statusEl) {
            statusEl.textContent = 'You have the latest version.';
            statusEl.classList.remove('update-available');
          }
          if (manual) showToast("You're on the latest version.");
        }
      } catch (e) {
        console.error('[Axis] update check failed:', e);
        if (statusEl) statusEl.textContent = 'Check GitHub for a newer release.';
        if (manual) showToast('Could not check for updates — check your connection.', true);
      } finally {
        if (manual && btnEl) { btnEl.disabled = false; btnEl.textContent = 'Check for Updates'; }
      }
    }

    function showUpdateBanner(tag, url) {
      if (updateDismissed) return;
      const banner = document.getElementById('update-banner');
      const text   = document.getElementById('update-banner-text');
      const link   = document.getElementById('update-banner-link');
      if (!banner) return;
      if (text) text.textContent = `A new version of Axis is available (${tag.replace(/^v/i, '')}).`;
      if (link) link.href = url;
      banner.style.display = 'flex';
    }

    function dismissUpdateBanner() {
      updateDismissed = true;
      const banner = document.getElementById('update-banner');
      if (banner) banner.style.display = 'none';
    }

    // ── FLIP REORDER ANIMATION ──────────────────────────
    // Generic helper: call captureFlipState() right before a container's
    // contents get rebuilt, then playFlipAnimation() right after. Elements
    // keyed by [data-id] that already existed glide from their old spot to
    // their new one; elements with no previous position play a fade/scale
    // entrance instead (new item added, or one revealed by a filter).
    // Elements that vanish (deleted, or hidden by a filter) don't need
    // special handling — the survivors gliding into the gap already reads
    // as the removal.
    let _reducedMotion = false;
    try { _reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { }

    function captureFlipState(container) {
      if (_reducedMotion || !container) return null;
      const map = new Map();
      container.querySelectorAll('[data-id]').forEach(el => {
        map.set(el.dataset.id, el.getBoundingClientRect());
      });
      return map;
    }

    function playFlipAnimation(container, prevRects) {
      if (_reducedMotion || !container || !prevRects || !prevRects.size) return;
      container.querySelectorAll('[data-id]').forEach(el => {
        const before = prevRects.get(el.dataset.id);
        if (!before) {
          // Wasn't on screen a moment ago — treat as a fresh entrance
          el.classList.add('card-enter');
          el.addEventListener('animationend', () => el.classList.remove('card-enter'), { once: true });
          return;
        }
        const after = el.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // didn't actually move

        el.style.transition = 'none';
        el.style.transform  = `translate(${dx}px, ${dy}px)`;
        // Force reflow so the browser registers the starting transform
        // before we clear it, otherwise both changes get batched together
        // and there's nothing to animate.
        void el.offsetWidth;
        el.classList.add('flip-move');
        el.style.transform = '';
        el.addEventListener('transitionend', () => {
          el.classList.remove('flip-move');
          el.style.transition = '';
        }, { once: true });
      });
    }

    // ── HELPERS ────────────────────────────────────────
    function overallScore(item) {
      if (!categories.length) return 0;
      const vals = categories.map(k => item.stats?.[k] ?? 0);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    // ── ICONS ──────────────────────────────────────────
    // Small hand-picked set of Lucide-style inline SVGs (24x24, 2px stroke,
    // currentColor) used in place of emoji for functional UI icons — emoji
    // render inconsistently across platforms and can't inherit button color
    // states the way these can. Sized via CSS on the containing button.
    const Icons = {
      pin:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
      swap:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>',
      edit:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
      trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      search:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
      sun:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
      moon:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
      grid:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
      list:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>',
      sliders:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg>',
      chart:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
      x:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
      check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      share:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/></svg>',
      copy:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
      settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
      folder:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
      clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
      calc:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>',
      eyeOff:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/><path d="M9.363 9.363A3 3 0 0 0 12 15a2.99 2.99 0 0 0 2.637-1.637"/></svg>',
      barChart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg>',
      radar:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10l7.07 7.07"/><path d="M12 12 4.93 19.07"/><circle cx="12" cy="12" r="10"/></svg>',
      layers:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>',
      upload:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
      download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
      plus:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
      chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
      image:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    };

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Makes a non-button element (a card, row, etc. that already has a real
    // onclick handler) reachable and operable by keyboard: focusable via
    // Tab, announced as a button by assistive tech, and activated by
    // Enter/Space the same way a native <button> would be. Call this right
    // after setting el.onclick — it reads that same handler rather than
    // taking a separate callback, so there's exactly one place defining
    // what the element does.
    function makeKeyboardClickable(el, label) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      if (label) el.setAttribute('aria-label', label);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.onclick?.(e);
        }
      });
    }

    // ── FOCUS TRAPPING ──────────────────────────────────
    // Keeps keyboard focus inside a modal/panel/drawer while it's open, so
    // Tab and Shift+Tab cycle through only what's visible in that surface
    // instead of leaking out to the grid underneath. One trap is active at
    // a time — opening a second (e.g. Categories from within Settings)
    // releases the first automatically, and closing the second restores
    // focus back into the first rather than all the way out to the page,
    // since _focusStack below preserves that chain.
    let _activeFocusTrap = null;   // { container, handler, previouslyFocused }
    const _focusStack = [];        // elements to restore through, most-recent last

    const FOCUSABLE_SELECTOR = [
      'a[href]', 'button:not([disabled])', 'input:not([disabled])',
      'select:not([disabled])', 'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    function _getFocusable(container) {
      return [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(el => el.offsetParent !== null); // visible only
    }

    // Call when a modal/panel/drawer opens. `container` is the element that
    // scopes the trap (usually the inner box, e.g. #modal, not the overlay
    // backdrop). `preferredFocusId`, if given and found, receives initial
    // focus (e.g. a name field); otherwise the first focusable element in
    // the container is used, falling back to the container itself.
    function trapFocus(container, preferredFocusId) {
      if (!container) return;
      if (_activeFocusTrap) _focusStack.push(_activeFocusTrap);

      const previouslyFocused = document.activeElement;
      const handler = e => {
        if (e.key !== 'Tab') return;
        const focusable = _getFocusable(container);
        if (!focusable.length) { e.preventDefault(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      };
      container.addEventListener('keydown', handler);
      _activeFocusTrap = { container, handler, previouslyFocused };

      const preferred = preferredFocusId && document.getElementById(preferredFocusId);
      const target = (preferred && preferred.offsetParent !== null)
        ? preferred
        : (_getFocusable(container)[0] || container);
      // If we're falling back to the container itself (no focusable child
      // found), it needs a tabindex to be focusable at all — native
      // elements like <div> aren't by default.
      if (target === container && !container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
      }
      setTimeout(() => target.focus(), 50);
    }

    // Call when that same modal/panel/drawer closes. Tears down the
    // listener and restores focus either to whatever was focused right
    // before this trap opened, or — if another trap was underneath it
    // (a modal opened from within another modal) — reactivates that one
    // instead of dropping focus out to the page.
    function releaseFocus(container) {
      if (!_activeFocusTrap || _activeFocusTrap.container !== container) return;
      _activeFocusTrap.container.removeEventListener('keydown', _activeFocusTrap.handler);
      const toRestore = _activeFocusTrap.previouslyFocused;
      _activeFocusTrap = _focusStack.pop() || null;
      if (toRestore && document.body.contains(toRestore) && toRestore.offsetParent !== null) {
        toRestore.focus();
      } else if (_activeFocusTrap) {
        _activeFocusTrap.container.focus?.();
      }
    }

    function linkify(text) {
      if (!text) return '';
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return escaped.replace(
        /(https?:\/\/[^\s<>"']+[^\s<>"'.,:;!?)\]'])/g,
        url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
      );
    }
    function getFilteredItems() {
      const q = searchQuery.toLowerCase().trim();
      let pool = items;
      if (activeTagFilter) {
        pool = pool.filter(item => (item.tags || []).includes(activeTagFilter));
      }
      // score range filter
      const sfActive = scoreFilterMin > 0 || scoreFilterMax < statMax;
      if (sfActive) {
        pool = pool.filter(item => {
          const s = overallScore(item);
          return s >= scoreFilterMin && s <= scoreFilterMax;
        });
      }
      if (!q) return pool;
      return pool.filter(item =>
        item.name.toLowerCase().includes(q) ||
        (item.bio || '').toLowerCase().includes(q) ||
        (item.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    function getSortedItems(pool) {
      return [...(pool || items)].sort((a, b) => {
        // Pinned items always first
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        let av, bv;
        if (currentSort.cat === 'overall') { av = overallScore(a); bv = overallScore(b); }
        else { av = a.stats?.[currentSort.cat] ?? -1; bv = b.stats?.[currentSort.cat] ?? -1; }
        return currentSort.dir === 'desc' ? bv - av : av - bv;
      });
    }

    // ── SEARCH ─────────────────────────────────────────
    function onSearch(val) {
      searchQuery = val;
      document.getElementById('search-clear').style.display = val ? 'block' : 'none';
      renderGrid();
      const filtered = getFilteredItems();
      const countEl = document.getElementById('search-count');
      countEl.textContent = (val && items.length) ? `${filtered.length}/${items.length}` : '';
    }
    function clearSearch() {
      document.getElementById('search-input').value = '';
      onSearch('');
      document.getElementById('search-input').focus();
    }

    // ── COMPARE SELECTION ──────────────────────────────
    function toggleCompare(id, e) {
      e.stopPropagation();
      if (compareSet.has(id)) {
        compareSet.delete(id);
      } else {
        if (compareSet.size >= 4) { showToast('Max 4 items for comparison.'); return; }
        compareSet.add(id);
      }
      renderCompareBar();
      // update card visual without full re-render
      document.querySelectorAll('.card').forEach(card => {
        const cid = card.dataset.id;
        if (!cid) return;
        card.classList.toggle('selected', compareSet.has(cid));
        const badge = card.querySelector('.card-select-badge');
        if (badge) {
          const idx = [...compareSet].indexOf(cid);
          badge.textContent = idx >= 0 ? idx + 1 : '';
        }
      });
    }
    function clearCompareSelection() {
      compareSet.clear();
      renderCompareBar();
      document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
    }
    function renderCompareBar() {
      const bar = document.getElementById('compare-bar');
      const count = compareSet.size;
      bar.classList.toggle('visible', count > 0);
      document.getElementById('compare-count').textContent =
        count === 0 ? '' : `${count} item${count > 1 ? 's' : ''} selected`;
      document.getElementById('compare-go-btn').disabled = count < 2;
    }

    // ── BULK EDIT STATS ──────────────────────────────────
    // Separate selection mode from Compare (no 4-item cap) for applying
    // one stat value across many items at once — e.g. after adding a new
    // category to a collection that already has 20 items.
    function enterBulkEditMode() {
      if (!categories.length) {
        showToast('Add a category first — bulk edit needs one to apply.', true);
        return;
      }
      bulkEditMode = true;
      bulkEditSet.clear();
      document.body.classList.add('bulk-edit-mode');

      // Populate the category dropdown fresh each time
      const catSelect = document.getElementById('bulk-edit-category');
      catSelect.innerHTML = categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

      const valInput = document.getElementById('bulk-edit-value');
      valInput.max = statMax;
      valInput.value = '';

      renderBulkEditBar();
      render();
      showToast('Bulk edit — click items to select, then choose a category and value.');
    }

    function exitBulkEditMode() {
      bulkEditMode = false;
      bulkEditSet.clear();
      document.body.classList.remove('bulk-edit-mode');
      document.getElementById('bulk-edit-bar').classList.remove('visible');
      render();
    }

    function toggleBulkSelect(id) {
      if (bulkEditSet.has(id)) bulkEditSet.delete(id);
      else bulkEditSet.add(id);
      renderBulkEditBar();
      const card = document.querySelector(`[data-id="${id}"]`);
      if (card) card.classList.toggle('bulk-selected', bulkEditSet.has(id));
    }

    function bulkSelectAll() {
      // Select everything currently visible under the active search/tag/
      // score filters — not literally every item ever created — since that
      // matches what the person can actually see on screen right now.
      getFilteredItems().forEach(item => bulkEditSet.add(item.id));
      renderBulkEditBar();
      render();
    }

    function bulkSelectNone() {
      bulkEditSet.clear();
      renderBulkEditBar();
      render();
    }

    function renderBulkEditBar() {
      const bar = document.getElementById('bulk-edit-bar');
      bar.classList.toggle('visible', bulkEditMode);
      const count = bulkEditSet.size;
      document.getElementById('bulk-edit-count').textContent =
        `${count} selected`;
    }

    async function applyBulkEdit() {
      if (bulkEditSet.size === 0) {
        showToast('Select at least one item first.', true);
        return;
      }
      const cat = document.getElementById('bulk-edit-category').value;
      if (!cat) {
        showToast('Choose a category first.', true);
        return;
      }
      const rawVal = document.getElementById('bulk-edit-value').value;
      let val = parseFloat(rawVal);
      if (rawVal === '' || isNaN(val)) {
        showToast('Enter a value first.', true);
        return;
      }
      val = Math.min(Math.max(0, val), statMax);

      const n = bulkEditSet.size;
      const confirmed = confirm(`Set "${cat}" to ${val} for ${n} item${n === 1 ? '' : 's'}?`);
      if (!confirmed) return;

      items.forEach(item => {
        if (bulkEditSet.has(item.id)) {
          item.stats = item.stats || {};
          item.stats[cat] = val;
        }
      });
      if (!incognitoMode) await axisSave(items, categories);
      render();
      renderBulkEditBar();
      document.getElementById('bulk-edit-value').value = '';
      showToast(`Set "${cat}" to ${val} for ${n} item${n === 1 ? '' : 's'}.`);
    }

    // ── RENDER ─────────────────────────────────────────
    const SORT_DROPDOWN_THRESHOLD = 4;

    function useSortDropdown() {
      return categories.length > SORT_DROPDOWN_THRESHOLD
        || categories.some(c => c.length > 14);
    }

    function renderSortBar() {
      const bar = document.getElementById('sort-bar');
      if (currentSort.cat !== 'overall' && !categories.includes(currentSort.cat)) {
        currentSort = { cat: 'overall', dir: 'desc' };
      }
      bar.innerHTML = '<span>Sort:</span>';

      const sortOptions = ['overall', ...categories];
      if (useSortDropdown()) {
        const wrap = document.createElement('div');
        wrap.className = 'sort-dropdown-wrap';

        const sel = document.createElement('select');
        sel.className = 'sort-select';
        sel.id = 'sort-select';
        sortOptions.forEach(cat => {
          const opt = document.createElement('option');
          opt.value = cat;
          opt.textContent = cat === 'overall' ? 'Overall' : cat;
          if (currentSort.cat === cat) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.onchange = () => {
          currentSort = { cat: sel.value, dir: currentSort.dir };
          renderGrid();
          renderOverall();
          renderSortBar();
        };

        const dirBtn = document.createElement('button');
        dirBtn.type = 'button';
        dirBtn.className = 'sort-dir-btn ' + currentSort.dir;
        dirBtn.id = 'sort-dir-btn';
        dirBtn.textContent = currentSort.dir === 'desc' ? '↓' : '↑';
        dirBtn.title = currentSort.dir === 'desc' ? 'Highest first — click to reverse' : 'Lowest first — click to reverse';
        dirBtn.onclick = () => {
          currentSort.dir = currentSort.dir === 'desc' ? 'asc' : 'desc';
          renderGrid();
          renderOverall();
          renderSortBar();
        };

        wrap.appendChild(sel);
        wrap.appendChild(dirBtn);
        bar.appendChild(wrap);
      } else {
        sortOptions.forEach(cat => {
          const btn = document.createElement('button');
          btn.className = 'sort-btn' + (currentSort.cat === cat ? ' active-' + currentSort.dir : '');
          btn.textContent = cat === 'overall' ? 'Overall' : cat;
          btn.onclick = () => {
            currentSort = currentSort.cat === cat
              ? { cat, dir: currentSort.dir === 'desc' ? 'asc' : 'desc' }
              : { cat, dir: 'desc' };
            renderSortBar();
            renderGrid();
            renderOverall();
          };
          bar.appendChild(btn);
        });
      }

      renderToolbarUtils();
    }

    function renderToolbarUtils() {
      const utils = document.getElementById('toolbar-utils');
      if (!utils) return;
      utils.innerHTML = '';

      if (items.length) {
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'toolbar-util-btn' + (viewMode === 'list' ? ' active' : '');
        viewBtn.id = 'view-toggle-btn';
        viewBtn.title = viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view';
        viewBtn.innerHTML = viewMode === 'list'
          ? `${Icons.grid} <span class="util-btn-label">Grid</span>`
          : `${Icons.list} <span class="util-btn-label">List</span>`;
        viewBtn.onclick = toggleView;
        utils.appendChild(viewBtn);
      }

      if (categories.length && items.length >= 2) {
        const sfBtn = document.createElement('button');
        sfBtn.type = 'button';
        sfBtn.className = 'toolbar-util-btn' + (document.getElementById('score-filter-bar')?.classList.contains('visible') ? ' active' : '');
        sfBtn.id = 'score-filter-toggle-btn';
        sfBtn.title = 'Filter by score range';
        sfBtn.innerHTML = Icons.sliders;
        sfBtn.onclick = toggleScoreFilter;
        utils.appendChild(sfBtn);
      }

      if (items.length) {
        const insBtn = document.createElement('button');
        insBtn.type = 'button';
        insBtn.className = 'toolbar-util-btn' + (document.getElementById('insights-panel')?.classList.contains('open') ? ' active' : '');
        insBtn.id = 'insights-toggle-btn';
        insBtn.title = 'Insights — ranking & stats';
        insBtn.innerHTML = `${Icons.chart} <span class="util-btn-label">Insights</span>`;
        insBtn.onclick = toggleInsights;
        utils.appendChild(insBtn);
      }
    }

    function renderOverall() {
      const section = document.getElementById('overall-section');
      // Update insights panel availability
      const panel = document.getElementById('insights-panel');
      const hasInsights = items.length > 0;
      if (panel) panel.classList.toggle('has-data', hasInsights);

      if (!items.length || !categories.length) {
        section.style.display = 'none';
        if (!items.length) closeInsightsPanel();
        return;
      }
      section.style.display = '';
      const sorted = [...items].sort((a, b) => overallScore(b) - overallScore(a));
      const list = document.getElementById('overall-list');
      const prevRects = captureFlipState(list);
      list.innerHTML = '';
      sorted.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'overall-item';
        div.dataset.id = item.id;
        div.onclick = () => openPanel(item.id);
        makeKeyboardClickable(div, `${item.name}, rank ${i + 1}, score ${overallScore(item).toFixed(1)}`);
        div.innerHTML = `<div class="overall-rank">#${i + 1}</div>
      <div class="overall-name">${esc(item.name)}</div>
      <div class="overall-score">${overallScore(item).toFixed(1)}</div>`;
        list.appendChild(div);
      });
      playFlipAnimation(list, prevRects);
    }

    function closeInsightsPanel() {
      const panel = document.getElementById('insights-panel');
      const btn = document.getElementById('insights-toggle-btn');
      panel?.classList.remove('open');
      btn?.classList.remove('active');
    }

    function toggleInsights() {
      const panel = document.getElementById('insights-panel');
      const btn = document.getElementById('insights-toggle-btn');
      const isOpen = panel.classList.toggle('open');
      if (btn) btn.classList.toggle('active', isOpen);
    }

    function closeScoreFilterPanel() {
      const bar = document.getElementById('score-filter-bar');
      const btn = document.getElementById('score-filter-toggle-btn');
      bar?.classList.remove('visible');
      btn?.classList.remove('active');
    }

    // Two-step onboarding for a brand new install: guides toward adding a
    // category first (the thing Axis actually needs to be useful), then
    // toward adding the first item once categories exist.
    function renderEmptyState() {
      const empty = document.getElementById('empty');
      if (!categories.length) {
        empty.innerHTML = `
          <h2>Start with a category</h2>
          <p>Axis compares things using categories you define — like Speed, Price, or Rating. Add a category to get started, or open Categories to load a ready-made starter template.</p>
          <div id="empty-steps">
            <div class="empty-step"><span>1</span>Add a category</div>
            <div class="empty-step"><span>2</span>Add an item</div>
            <div class="empty-step"><span>3</span>Compare &amp; rank</div>
          </div>
          <button class="btn primary" onclick="openCatModal()">+ Add Your First Category</button>
        `;
      } else {
        empty.innerHTML = `
          <h2>Ready for your first item</h2>
          <p>Your categories are set. Add an item to start ranking and comparing.</p>
          <button class="btn primary" onclick="openAddModal()">+ Add First Item</button>
        `;
      }
    }

    function renderGrid() {
      const grid = document.getElementById('grid');
      const empty = document.getElementById('empty');
      // Skip the per-item FLIP capture while a grid/list mode crossfade is
      // in progress (see toggleView) — matching cards to rows by data-id
      // would try to glide-transform between two incompatible layouts,
      // which looks broken rather than smooth. The container-level fade
      // already covers this transition on its own.
      const switching = grid.classList.contains('view-switching');
      const prevRects = switching ? null : captureFlipState(grid);
      grid.innerHTML = '';

      const filtered = getFilteredItems();

      if (!items.length) {
        renderEmptyState();
        empty.style.display = 'flex';
        return;
      }
      empty.style.display = 'none';

      computeScoreTiers();
      grid.classList.remove('list-mode');
      const sorted = getSortedItems(filtered);

      if (viewMode === 'list') { renderListView(sorted, prevRects); return; }

      if (filtered.length === 0 && searchQuery) {
        const msg = document.createElement('p');
        msg.style.cssText = 'grid-column:1/-1;color:var(--muted);font-size:.88rem;padding:20px 0;';
        msg.textContent = `No items match "${searchQuery}"`;
        grid.appendChild(msg);
        grid.appendChild(makeAddCard());
        return;
      }

      sorted.forEach(item => {
        const card = document.createElement('div');
        const tier = scoreTier(item);
        card.className = 'card' + (compareSet.has(item.id) ? ' selected' : '') + (bulkEditSet.has(item.id) ? ' bulk-selected' : '') + (item.pinned ? ' pinned' : '') + (tier ? ' ' + tier : '');
        card.dataset.id = item.id;

        const score = currentSort.cat === 'overall'
          ? overallScore(item)
          : (item.stats?.[currentSort.cat] ?? 0);

        const _src = axisImgSrc(item.img);
        const imgHtml = _src
          ? `<img src="${esc(_src)}" alt="${esc(item.name)}" loading="lazy">`
          : `<div class="placeholder">◈</div>`;

        const selIdx = [...compareSet].indexOf(item.id);

        const tagChipsHtml = (item.tags || []).slice(0, 3).map(t =>
          `<span class="tag-chip">${esc(t)}</span>`).join('') +
          ((item.tags || []).length > 3 ? `<span class="tag-chip">+${item.tags.length - 3}</span>` : '');

        card.innerHTML = `
      ${item.pinned ? `<span class="pin-indicator">${Icons.pin}</span>` : ''}
      <div class="card-select-badge">${selIdx >= 0 ? selIdx + 1 : ''}</div>
      <div class="bulk-checkbox">${Icons.check}</div>
      <div class="card-img-wrap">${imgHtml}</div>
      <div class="card-body">
        <div class="card-name">${esc(item.name)}</div>
        <div class="card-score">
          <div class="card-score-bar"><div class="card-score-fill" style="width:${(Math.min(score, statMax) / statMax * 100).toFixed(1)}%"></div></div>
          <div class="card-score-val">${score.toFixed(1)}</div>
        </div>
        ${tagChipsHtml ? `<div class="card-tags">${tagChipsHtml}</div>` : ''}
      </div>
      <div class="card-actions">
        <button class="card-action-btn pin ${item.pinned ? 'active' : ''}" title="${item.pinned ? 'Unpin' : 'Pin'}" aria-label="${item.pinned ? 'Unpin' : 'Pin'} ${esc(item.name)}" onclick="event.stopPropagation();pinItem('${item.id}')">${Icons.pin}</button>
        <button class="card-action-btn edit" title="Select for compare" aria-label="Select ${esc(item.name)} for compare" onclick="toggleCompare('${item.id}',event)">${Icons.swap}</button>
        <button class="card-action-btn edit" title="Edit" aria-label="Edit ${esc(item.name)}" onclick="event.stopPropagation();openEditModal('${item.id}')">${Icons.edit}</button>
        <button class="card-action-btn del"  title="Delete" aria-label="Delete ${esc(item.name)}" onclick="event.stopPropagation();deleteItem('${item.id}')">${Icons.trash}</button>
      </div>`;

        card.onclick = () => {
          if (bulkEditMode) { toggleBulkSelect(item.id); return; }
          openPanel(item.id);
        };
        makeKeyboardClickable(card, `${item.name}, score ${score.toFixed(1)}`);
        grid.appendChild(card);
      });

      grid.appendChild(makeAddCard());
      playFlipAnimation(grid, prevRects);
    }

    function makeAddCard() {
      const d = document.createElement('div');
      d.className = 'card-add';
      d.onclick = openAddModal;
      d.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Add Item</span>`;
      return d;
    }

    function render() { renderSortBar(); renderOverall(); renderGrid(); renderTagFilterBar(); renderStatsBar(); renderScoreFilterBar(); }

    // ── SIDE PANEL ─────────────────────────────────────
    function openPanel(id) {
      const item = items.find(x => x.id === id);
      if (!item) return;

      document.getElementById('panel-name').textContent = item.name;
      const dateEl = document.getElementById('panel-date');
      if (item.createdAt) {
        const d = new Date(item.createdAt);
        dateEl.textContent = 'Added ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } else { dateEl.textContent = ''; }

      // Build image carousel
      _panelImgs = [item.img, item.img2, item.img3, item.img4, item.img5].map(axisImgSrc).filter(Boolean);
      _panelImgIdx = 0;
      _renderPanelCarousel();

      const tagsEl = document.getElementById('panel-tags');
      tagsEl.innerHTML = (item.tags || []).map(t =>
        `<button type="button" class="tag-chip interactive" aria-label="Filter by tag ${esc(t)}" onclick="setTagFilter('${esc(t)}');closePanel()">${esc(t)}</button>`
      ).join('');

      const bioEl   = document.getElementById('panel-bio');
      const bioWrap = document.getElementById('panel-bio-wrap');
      bioEl.innerHTML = linkify(item.bio || '');
      bioWrap.style.display = item.bio ? 'block' : 'none';
      bioWrap.classList.remove('has-toggle');
      if (item.bio) {
        // Apply the collapsed constraint FIRST so clientHeight reflects the
        // clamped box — measuring before this always reported "not overflowing"
        // because an unclamped element's scrollHeight == clientHeight.
        bioWrap.classList.add('collapsed');
        requestAnimationFrame(() => {
          const isOverflowing = bioEl.scrollHeight > bioEl.clientHeight + 4;
          if (isOverflowing) {
            bioWrap.classList.add('has-toggle');
            document.getElementById('panel-bio-toggle').textContent = 'Read more ▾';
          } else {
            // Short bio — no need to clamp or show a toggle
            bioWrap.classList.remove('collapsed');
          }
        });
      } else {
        bioWrap.classList.remove('collapsed');
      }

      const statsEl = document.getElementById('panel-stats');
      statsEl.innerHTML = '';
      if (categories.length) {
        categories.forEach(k => {
          const v = item.stats?.[k] ?? 0;
          const row = document.createElement('div');
          row.className = 'stat-row';
          const statNote = item.statNotes?.[k] || '';
          row.innerHTML = `<div class="stat-label">${esc(k)}</div>
        <div class="stat-bar"><div class="stat-fill" style="width:${(v / statMax * 100).toFixed(1)}%"></div></div>
        <div class="stat-val">${v}</div>`;
          if (statNote) {
            const noteDiv = document.createElement('div');
            noteDiv.className = 'panel-stat-note';
            noteDiv.textContent = statNote;
            row.appendChild(noteDiv);
          }
          statsEl.appendChild(row);
        });
      } else {
        statsEl.innerHTML = '<p style="font-size:.82rem;color:var(--muted);">No categories defined yet.</p>';
      }

      const pinBtn = document.getElementById('panel-pin-btn');
      pinBtn.innerHTML = `${Icons.pin} ${item.pinned ? 'Unpin' : 'Pin'}`;
      pinBtn.onclick = () => pinItem(id);
      document.getElementById('panel-share-btn').onclick = () => shareItemAsImage(item);
      document.getElementById('panel-dup-btn').onclick = () => { closePanel(); duplicateItem(id); };
      document.getElementById('panel-edit-btn').onclick = () => { closePanel(); openEditModal(id); };
      document.getElementById('panel-del-btn').onclick = () => deleteItem(id);

      document.getElementById('panel-overlay').classList.add('open');
      document.getElementById('panel').classList.add('open');
      trapFocus(document.getElementById('panel'));
    }
    function closePanel() {
      document.getElementById('panel-overlay').classList.remove('open');
      document.getElementById('panel').classList.remove('open');
      releaseFocus(document.getElementById('panel'));
    }

    // ── COMPARE VIEW ───────────────────────────────────
    // ── COMPARE RADAR CHART ─────────────────────────────
    let cmpRadarOpen = false;
    let cmpBarsOpen  = false;
    let _cmpSelectedItems = []; // cached for redraw on toggle

    function toggleCmpRadar() {
      cmpRadarOpen = !cmpRadarOpen;
      const wrap = document.getElementById('cmp-radar-wrap');
      const btn  = document.getElementById('cmp-radar-toggle');
      wrap.classList.toggle('visible', cmpRadarOpen);
      btn.classList.toggle('active', cmpRadarOpen);
      if (cmpRadarOpen) drawCmpRadar(_cmpSelectedItems);
    }

    function toggleCmpBars() {
      cmpBarsOpen = !cmpBarsOpen;
      const wrap = document.getElementById('cmp-bars-wrap');
      const btn  = document.getElementById('cmp-bars-toggle');
      wrap.classList.toggle('visible', cmpBarsOpen);
      btn.classList.toggle('active', cmpBarsOpen);
      if (cmpBarsOpen) drawCmpBars(_cmpSelectedItems);
    }

    // ── RADAR ZOOM (full-screen) ─────────────────────────
    // Reuses drawCmpRadar's exact drawing logic against a second, much
    // larger canvas rather than duplicating the chart math.
    let _radarZoomResizeHandler = null;

    function openRadarZoom() {
      if (categories.length < 3) { showToast('Radar needs at least 3 categories to draw a shape.', true); return; }
      const overlay = document.getElementById('radar-zoom-overlay');
      if (!overlay) return;
      overlay.classList.add('open');
      redrawRadarZoom();
      trapFocus(overlay);

      // Re-layout on resize while the zoom view is open (window resize,
      // or rotating a tablet) — capped with a small debounce
      let t;
      _radarZoomResizeHandler = () => { clearTimeout(t); t = setTimeout(redrawRadarZoom, 120); };
      window.addEventListener('resize', _radarZoomResizeHandler);
    }

    function closeRadarZoom() {
      const overlay = document.getElementById('radar-zoom-overlay');
      if (overlay) { overlay.classList.remove('open'); releaseFocus(overlay); }
      if (_radarZoomResizeHandler) {
        window.removeEventListener('resize', _radarZoomResizeHandler);
        _radarZoomResizeHandler = null;
      }
    }

    function redrawRadarZoom() {
      const wrap = document.getElementById('radar-zoom-wrap');
      if (!wrap) return;
      // Leaves room for the legend below and header/padding above+below;
      // width is capped by the wrap's own available space either way.
      const maxSize = Math.min(wrap.clientWidth || 900, window.innerHeight - 220);
      drawCmpRadar(_cmpSelectedItems, {
        canvasId: 'radar-zoom-canvas',
        legendId: 'radar-zoom-legend',
        wrapId:   'radar-zoom-wrap',
        maxSize:  Math.max(320, maxSize)
      });
    }

    // Distinct, theme-consistent colours per compare slot (max 4 items)
    const CMP_RADAR_COLORS = ['#d94f5c', '#4ae8c9', '#e8c94a', '#8a7fe8'];

    // Wrap a category label to fit maxWidth px, using at most 2 lines.
    // Long single words are truncated but never below half their original
    // length, so the reader always gets at least the meaningful first half
    // rather than a random mid-word chop. Both lines are bounds-checked —
    // a label like "Soundtrack & Radio Stations" can produce a first half
    // ("Soundtrack &") that's still too wide on its own, so line1 needs the
    // same truncation safety net line2 already had. Shared by the radar and
    // bar chart.
    function wrapChartLabel(ctx, text, maxWidth) {
      function truncateToFit(s) {
        if (ctx.measureText(s).width <= maxWidth) return s;
        let t = s;
        const minLen = Math.max(3, Math.ceil(s.length / 2));
        while (t.length > minLen && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
        return t + '…';
      }

      const words = text.split(' ');
      if (words.length === 1) return [truncateToFit(text)];
      if (ctx.measureText(text).width <= maxWidth) return [text];
      let mid = Math.floor(text.length / 2);
      let splitIdx = text.lastIndexOf(' ', mid);
      if (splitIdx === -1) splitIdx = text.indexOf(' ', mid);
      if (splitIdx === -1) splitIdx = mid;
      const line1 = truncateToFit(text.slice(0, splitIdx).trim());
      const line2 = truncateToFit(text.slice(splitIdx).trim());
      return [line1, line2];
    }

    // Returns the RGB triplet to build rgba(...) chart colors from, matching
    // the app's current --text color so radar/bar charts stay readable in
    // both themes (unlike shareItemAsImage, which is intentionally fixed-dark).
    function _chartInkRGB() {
      return document.body.classList.contains('light') ? '51,59,60' : '232,232,236';
    }

    // opts lets a second caller (the full-screen zoom view) reuse this exact
    // drawing logic against different target elements and a larger canvas,
    // instead of duplicating ~120 lines of chart-drawing math.
    function drawCmpRadar(selected, opts) {
      opts = opts || {};
      const canvas = document.getElementById(opts.canvasId || 'cmp-radar-canvas');
      const legend = document.getElementById(opts.legendId || 'cmp-radar-legend');
      const wrap   = document.getElementById(opts.wrapId   || 'cmp-radar-wrap');
      const ink    = _chartInkRGB();
      legend.innerHTML = '';

      if (!categories.length || categories.length < 3) {
        canvas.style.display = 'none';
        legend.innerHTML = '<div id="cmp-radar-empty">Radar needs at least 3 categories to draw a shape.</div>';
        return;
      }
      canvas.style.display = 'block';

      const N = categories.length;
      const maxSize = opts.maxSize || 460;
      const size = Math.min(maxSize, wrap.clientWidth || maxSize);
      const DPR = Math.max(1, Math.round(window.devicePixelRatio || 1));
      canvas.width  = size * DPR;
      canvas.height = size * DPR;
      canvas.style.width  = size + 'px';
      canvas.style.height = size + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(DPR, DPR);
      ctx.clearRect(0, 0, size, size);

      // Labels, dots, and line weight scale gently with canvas size so the
      // zoomed view looks like a bigger chart, not the same chart stretched
      const scale = size / 460;
      const cx = size / 2, cy = size / 2;
      const labelPad = 62 * scale; // more room so labels rarely need truncating
      const R = size / 2 - labelPad;
      const rings = 4;

      const angleFor = i => (Math.PI * 2 * i) / N - Math.PI / 2;

      // ── Ring grid (concentric N-gons) ───────────────────────────────────
      ctx.strokeStyle = `rgba(${ink},0.14)`;
      ctx.lineWidth = Math.max(1, scale);
      for (let r = 1; r <= rings; r++) {
        const ringR = (R * r) / rings;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const a = angleFor(i % N);
          const x = cx + ringR * Math.cos(a);
          const y = cy + ringR * Math.sin(a);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // ── Spokes ───────────────────────────────────────────────────────────
      ctx.strokeStyle = `rgba(${ink},0.22)`;
      for (let i = 0; i < N; i++) {
        const a = angleFor(i);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a));
        ctx.stroke();
      }

      // ── Category labels — full name where possible, wrapped to 2 lines,
      //    truncated only as a last resort (keeping at least half the word) ──
      const labelFontPx = Math.round(10.5 * scale * 10) / 10;
      ctx.font = `600 ${labelFontPx}px Barlow, system-ui, sans-serif`;
      ctx.fillStyle = `rgba(${ink},0.72)`;
      const LABEL_MAX_W = 96 * scale; // cap for top/bottom labels, which have room on both sides
      const LABEL_MARGIN = 6 * scale; // breathing room before the literal canvas edge
      const LABEL_LINE_H = 12 * scale;
      categories.forEach((k, i) => {
        const a = angleFor(i);
        const lx = cx + (R + 26 * scale) * Math.cos(a);
        const ly = cy + (R + 26 * scale) * Math.sin(a);
        const align = Math.cos(a) > 0.2 ? 'left' : Math.cos(a) < -0.2 ? 'right' : 'center';
        ctx.textAlign = align;
        const vertDir = Math.sin(a) > 0.2 ? 'down' : Math.sin(a) < -0.2 ? 'up' : 'center';

        // Text only grows in the direction textAlign implies, so the real
        // available width is however much canvas is actually left on that
        // side of the anchor point — not a flat constant. Side-anchored
        // labels (left/right of the circle) sit close to the horizontal
        // edges and have noticeably less room than top/bottom labels,
        // which is exactly why long side labels were clipping before.
        let availW;
        if (align === 'left')       availW = size - lx - LABEL_MARGIN;
        else if (align === 'right') availW = lx - LABEL_MARGIN;
        else                        availW = Math.min(lx, size - lx) * 2 - LABEL_MARGIN;
        const maxW = Math.max(28 * scale, Math.min(LABEL_MAX_W, availW));

        const lines = wrapChartLabel(ctx, k.toUpperCase(), maxW);
        const totalH = lines.length * LABEL_LINE_H;
        ctx.textBaseline = 'middle';
        let startY;
        if (vertDir === 'down')      startY = ly + LABEL_LINE_H / 2;
        else if (vertDir === 'up')   startY = ly - totalH + LABEL_LINE_H / 2;
        else                          startY = ly - totalH / 2 + LABEL_LINE_H / 2;
        lines.forEach((line, li) => ctx.fillText(line, lx, startY + li * LABEL_LINE_H));
      });

      // ── Item polygons ────────────────────────────────────────────────────
      selected.forEach((item, idx) => {
        const color = CMP_RADAR_COLORS[idx % CMP_RADAR_COLORS.length];
        ctx.beginPath();
        categories.forEach((k, i) => {
          const v   = Math.min(item.stats?.[k] ?? 0, statMax);
          const pct = statMax > 0 ? v / statMax : 0;
          const a   = angleFor(i);
          const x   = cx + R * pct * Math.cos(a);
          const y   = cy + R * pct * Math.sin(a);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = color + '26'; // ~15% alpha fill
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * scale;
        ctx.stroke();

        // Vertex dots
        categories.forEach((k, i) => {
          const v   = Math.min(item.stats?.[k] ?? 0, statMax);
          const pct = statMax > 0 ? v / statMax : 0;
          const a   = angleFor(i);
          const x   = cx + R * pct * Math.cos(a);
          const y   = cy + R * pct * Math.sin(a);
          ctx.beginPath();
          ctx.arc(x, y, 3 * scale, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        });

        // Legend chip
        const chip = document.createElement('div');
        chip.className = 'cmp-chart-legend-item';
        chip.innerHTML = `<span class="cmp-chart-legend-swatch" style="background:${color}"></span>${esc(item.name)}`;
        legend.appendChild(chip);
      });
    }

    // ── COMPARE BAR CHART ────────────────────────────────
    // Grouped bars — one group per category, one bar per selected item.
    // Complements the radar: easier to read exact "who's ahead" per category
    // than a radar's angular spokes, especially with 3+ items selected.
    function drawCmpBars(selected) {
      const canvas = document.getElementById('cmp-bars-canvas');
      const legend = document.getElementById('cmp-bars-legend');
      const wrap   = document.getElementById('cmp-bars-wrap');
      const ink    = _chartInkRGB();
      legend.innerHTML = '';

      if (!categories.length) {
        canvas.style.display = 'none';
        legend.innerHTML = '<div id="cmp-bars-empty">No categories to chart yet.</div>';
        return;
      }
      canvas.style.display = 'block';

      const N = categories.length;
      const width  = Math.min(680, wrap.clientWidth || 680);
      const height = 300;
      const DPR = Math.max(1, Math.round(window.devicePixelRatio || 1));
      canvas.width  = width * DPR;
      canvas.height = height * DPR;
      canvas.style.width  = width + 'px';
      canvas.style.height = height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(DPR, DPR);
      ctx.clearRect(0, 0, width, height);

      // Chart plot area — room left for y-axis labels, bottom for category labels
      const padL = 42, padR = 12, padT = 14, padB = 46;
      const x0 = padL, x1 = width - padR;
      const y0 = padT,  y1 = height - padB;
      const plotW = x1 - x0, plotH = y1 - y0;

      // ── Y-axis gridlines + value labels (0, 25%, 50%, 75%, 100% of statMax) ──
      ctx.strokeStyle = `rgba(${ink},0.16)`;
      ctx.font = '500 10px Barlow, system-ui, sans-serif';
      ctx.fillStyle = `rgba(${ink},0.6)`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let g = 0; g <= 4; g++) {
        const frac = g / 4;
        const gy = y1 - plotH * frac;
        ctx.beginPath();
        ctx.moveTo(x0, gy);
        ctx.lineTo(x1, gy);
        ctx.lineWidth = 1;
        ctx.stroke();
        const val = Math.round(statMax * frac);
        ctx.fillText(String(val), x0 - 8, gy);
      }

      // ── Grouped bars ─────────────────────────────────────────────────────
      const groupW = plotW / N;
      const groupPad = Math.min(16, groupW * 0.18);
      const barsPerGroup = Math.max(1, selected.length);
      const barGap = 2;
      const barW = (groupW - groupPad * 2 - barGap * (barsPerGroup - 1)) / barsPerGroup;

      categories.forEach((cat, ci) => {
        const groupX0 = x0 + ci * groupW + groupPad;
        selected.forEach((item, ii) => {
          const v   = Math.min(item.stats?.[cat] ?? 0, statMax);
          const pct = statMax > 0 ? v / statMax : 0;
          const barH = plotH * pct;
          const bx = groupX0 + ii * (barW + barGap);
          const by = y1 - barH;
          const color = CMP_RADAR_COLORS[ii % CMP_RADAR_COLORS.length];

          ctx.fillStyle = color;
          ctx.fillRect(bx, by, Math.max(1, barW), Math.max(1, barH));

          // Value label above the bar, only if there's room
          if (barW >= 16) {
            ctx.font = '700 9px Barlow, system-ui, sans-serif';
            ctx.fillStyle = `rgba(${ink},0.8)`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(String(v), bx + barW / 2, Math.max(by - 4, 10));
          }
        });
      });

      // ── Baseline axis ────────────────────────────────────────────────────
      ctx.strokeStyle = `rgba(${ink},0.3)`;
      ctx.beginPath();
      ctx.moveTo(x0, y1);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      // ── Category labels below each group — same wrap logic as the radar ──
      ctx.font = '600 10px Barlow, system-ui, sans-serif';
      ctx.fillStyle = `rgba(${ink},0.72)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const LABEL_LINE_H = 12;
      categories.forEach((cat, ci) => {
        const groupCx = x0 + ci * groupW + groupW / 2;
        const lines = wrapChartLabel(ctx, cat.toUpperCase(), groupW - 4);
        lines.forEach((line, li) => {
          ctx.fillText(line, groupCx, y1 + 8 + li * LABEL_LINE_H);
        });
      });

      // ── Legend ───────────────────────────────────────────────────────────
      selected.forEach((item, idx) => {
        const color = CMP_RADAR_COLORS[idx % CMP_RADAR_COLORS.length];
        const chip = document.createElement('div');
        chip.className = 'cmp-chart-legend-item';
        chip.innerHTML = `<span class="cmp-chart-legend-swatch" style="background:${color}"></span>${esc(item.name)}`;
        legend.appendChild(chip);
      });
    }

    function openCompare() {
      if (compareSet.size < 2) return;
      const selected = [...compareSet].map(id => items.find(x => x.id === id)).filter(Boolean);
      _cmpSelectedItems = selected;
      if (cmpRadarOpen) drawCmpRadar(selected);
      if (cmpBarsOpen)  drawCmpBars(selected);

      // For each category, find the max value across selected items
      const maxPerCat = {};
      categories.forEach(k => {
        maxPerCat[k] = Math.max(...selected.map(x => x.stats?.[k] ?? 0));
      });

      const table = document.getElementById('cmp-table');
      table.innerHTML = '';

      selected.forEach(item => {
        const col = document.createElement('div');
        col.className = 'cmp-col';

        const cmpSrc = axisImgSrc(item.img);
        const imgHtml = cmpSrc
          ? `<img class="cmp-col-img" src="${esc(cmpSrc)}" alt="${esc(item.name)}">`
          : `<div class="cmp-col-img-ph">◈</div>`;

        const score = overallScore(item);

        let statsHtml = '';
        categories.forEach(k => {
          const v = item.stats?.[k] ?? 0;
          const max = maxPerCat[k];
          const isWinner = v === max && max > 0;
          statsHtml += `
        <div class="cmp-stat">
          <div class="cmp-stat-label">${esc(k)}${isWinner ? '<span class="cmp-winner-badge">best</span>' : ''}</div>
          <div class="cmp-stat-bar-wrap">
            <div class="cmp-stat-bar"><div class="cmp-stat-fill${isWinner ? ' winner' : ''}" style="width:${(v / statMax * 100).toFixed(1)}%"></div></div>
            <div class="cmp-stat-val${isWinner ? ' winner' : ''}">${v}</div>
          </div>
        </div>`;
        });

        if (!categories.length) statsHtml = '<div class="cmp-stat" style="color:var(--muted);font-size:.82rem;">No categories defined.</div>';

        col.innerHTML = `${imgHtml}
      <div class="cmp-col-name">${esc(item.name)}</div>
      <div class="cmp-col-score">Overall: <span>${score.toFixed(1)}/${statMax}</span></div>
      ${statsHtml}`;

        table.appendChild(col);
      });

      document.getElementById('cmp-overlay').classList.add('open');
      trapFocus(document.getElementById('cmp-overlay'));
    }
    function closeCompare() {
      document.getElementById('cmp-overlay').classList.remove('open');
      closeRadarZoom();
      releaseFocus(document.getElementById('cmp-overlay'));
    }

    // ── ADD / EDIT MODAL ───────────────────────────────
    function openAddModal() {
      editingId = null; pendingImages = [];
      document.getElementById('modal-title').textContent = 'Add Item';
      document.getElementById('f-name').value = '';
      document.getElementById('f-img-url-input').value = '';
      document.getElementById('f-img-file-input').value = '';
      renderImageThumbs();
      document.getElementById('f-bio').value = '';
      pendingTags = [];
      renderTagInputChips();
      buildStatFields({});
      document.getElementById('modal-overlay').classList.add('open');
      trapFocus(document.getElementById('modal'), 'f-name');
    }

    function openEditModal(id) {
      const item = items.find(x => x.id === id);
      if (!item) return;
      editingId = id;
      pendingImages = [item.img, item.img2, item.img3, item.img4, item.img5].filter(Boolean);

      document.getElementById('modal-title').textContent = 'Edit Item';
      document.getElementById('f-name').value = item.name;
      document.getElementById('f-bio').value = item.bio || '';
      document.getElementById('f-img-url-input').value = '';
      document.getElementById('f-img-file-input').value = '';
      renderImageThumbs();

      pendingTags = [...(item.tags || [])];
      renderTagInputChips();
      buildStatFields(item.stats || {}, item.statNotes || {});
      document.getElementById('modal-overlay').classList.add('open');
      trapFocus(document.getElementById('modal'), 'f-name');
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
      releaseFocus(document.getElementById('modal'));
      pendingImages = [];
    }

    function buildStatFields(existing, existingNotes) {
      const container = document.getElementById('stat-fields');
      const note = document.getElementById('no-cats-note');
      container.innerHTML = '';
      if (!categories.length) { note.style.display = 'block'; return; }
      note.style.display = 'none';
      const step = 0.5;
      const defaultVal = statMax === 100 ? 50 : 5;
      categories.forEach(cat => {
        const raw = existing[cat] !== undefined ? parseFloat(existing[cat]) : defaultVal;
        const val = isNaN(raw) ? defaultVal : Math.max(0, raw);
        // Slider max is the larger of statMax or val so existing /100 data displays correctly
        const sliderMax = Math.max(statMax, val);
        const div = document.createElement('div');
        div.className = 'stat-field-row'; div.dataset.cat = cat;
        const existingNote = (existingNotes && existingNotes[cat]) ? existingNotes[cat] : '';
        div.innerHTML = `<div class="stat-field-name">${esc(cat)}</div>
      <div class="range-row">
        <input type="range" min="0" max="${sliderMax}" step="${step}" value="${val}">
        <input type="number" class="range-num" min="0" max="${sliderMax}" step="${step}" value="${val}">
      </div>
      <div class="stat-note-wrap">
        <input type="text" class="stat-note-input" placeholder="Note for ${esc(cat)}..." value="${esc(existingNote)}">
      </div>`;
        const slider = div.querySelector('input[type=range]');
        const numIn = div.querySelector('.range-num');
        slider.addEventListener('input', () => { numIn.value = parseFloat(slider.value); });
        numIn.addEventListener('input', () => {
          let v = parseFloat(numIn.value);
          if (isNaN(v)) return;
          slider.value = Math.min(Math.max(0, v), statMax);
        });
        numIn.addEventListener('blur', () => {
          let v = parseFloat(numIn.value);
          if (isNaN(v) || v < 0) v = 0;
          if (v > statMax) v = statMax;
          numIn.value = v; slider.value = v;
        });
        container.appendChild(div);
      });
    }

    function saveItem() {
      const name = document.getElementById('f-name').value.trim();
      if (!name) { showToast('Name is required.', true); return; }

      const img  = pendingImages[0] || '';
      const img2 = pendingImages[1] || '';
      const img3 = pendingImages[2] || '';
      const img4 = pendingImages[3] || '';
      const img5 = pendingImages[4] || '';
      const bio = document.getElementById('f-bio').value.trim();

      const stats = {};
      document.querySelectorAll('#stat-fields .stat-field-row').forEach(row => {
        const cat = row.dataset.cat;
        const numIn = row.querySelector('.range-num');
        const range = row.querySelector('input[type=range]');
        if (cat) {
          const raw = numIn ? parseFloat(numIn.value) : (range ? parseFloat(range.value) : 0);
          stats[cat] = isNaN(raw) ? 0 : Math.min(Math.max(0, raw), statMax);
        }
      });

      const statNotes = {};
      document.querySelectorAll('#stat-fields .stat-field-row').forEach(row => {
        const cat = row.dataset.cat;
        const noteEl = row.querySelector('.stat-note-input');
        if (cat && noteEl && noteEl.value.trim()) statNotes[cat] = noteEl.value.trim();
      });
      const tags = [...pendingTags];
      let isDuplicateName = false;
      if (editingId) {
        const item = items.find(x => x.id === editingId);
        if (item) Object.assign(item, { name, img, img2, img3, img4, img5, bio, stats, tags, statNotes });
      } else {
        isDuplicateName = items.some(x => x.name.toLowerCase() === name.toLowerCase());
        items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, img, img2, img3, img4, img5, bio, stats, tags, statNotes, createdAt: Date.now() });
      }

      save(); closeModal(); render();
      showToast(
        editingId ? 'Item updated.'
        : isDuplicateName ? `Item added — you already have another "${name}".`
        : 'Item added.'
      );
    }

    function deleteItem(id) {
      if (!confirm('Delete this item?')) return;
      const idx = items.findIndex(x => x.id === id);
      if (idx === -1) return;
      lastDeleted = { item: JSON.parse(JSON.stringify(items[idx])), index: idx };
      items.splice(idx, 1);
      compareSet.delete(id);
      save(); closePanel(); renderCompareBar(); render();
      // show toast with undo button
      const t = document.getElementById('toast');
      t.innerHTML = 'Item deleted. <button onclick="undoDelete()" style="margin-left:8px;background:none;border:1px solid var(--accent);color:var(--accent);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:.75rem;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:2px;cursor:pointer;">↩ Undo</button>';
      t.className = 'show';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.className = ''; lastDeleted = null; }, 5000);
    }
    function undoDelete() {
      if (!lastDeleted) return;
      items.splice(lastDeleted.index, 0, lastDeleted.item);
      lastDeleted = null;
      clearTimeout(toastTimer);
      save(); render();
      showToast('Delete undone.');
    }

    // ── IMAGE HANDLING ─────────────────────────────────
    // ── UNIFIED IMAGE MANAGER ──────────────────────────
    function renderImageThumbs() {
      const strip = document.getElementById('img-thumb-strip');
      if (!strip) return;
      strip.innerHTML = '';
      pendingImages.forEach((src, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'img-thumb' + (i === 0 ? ' is-primary' : '');
        const badgeText = ['Primary','2nd','3rd','4th','5th'][i] || String(i+1);
        thumb.innerHTML = `
      <img src="${esc(src)}" alt="${badgeText} image preview">
      <span class="img-thumb-badge">${badgeText}</span>
      <button type="button" class="img-thumb-remove" title="Remove" aria-label="Remove ${badgeText} image" onclick="removePendingImage(${i})">${Icons.x}</button>
      <div class="img-thumb-nav">
        <button type="button" title="Move left"  aria-label="Move ${badgeText} image left"  ${i === 0 ? 'disabled' : ''} onclick="movePendingImage(${i}, -1)">‹</button>
        <button type="button" title="Move right" aria-label="Move ${badgeText} image right" ${i === pendingImages.length - 1 ? 'disabled' : ''} onclick="movePendingImage(${i}, 1)">›</button>
      </div>`;
        strip.appendChild(thumb);
      });
      const atLimit = pendingImages.length >= 5;
      if (!atLimit) {
        const empty = document.createElement('div');
        empty.className = 'img-thumb-empty';
        empty.textContent = '+';
        empty.title = 'Upload image';
        empty.style.cursor = 'pointer';
        empty.onclick = () => { document.getElementById('f-img-file-input').click(); };
        strip.appendChild(empty);
      }
      const urlInput = document.getElementById('f-img-url-input');
      const fileInput = document.getElementById('f-img-file-input');
      if (urlInput) urlInput.disabled = atLimit;
      if (fileInput) fileInput.disabled = atLimit;
    }

    function addImageFromUrlInput() {
      if (pendingImages.length >= 5) { showToast('Maximum 5 images per item.', true); return; }
      const input = document.getElementById('f-img-url-input');
      const url = input.value.trim();
      if (!url) return;
      pendingImages.push(url);
      input.value = '';
      renderImageThumbs();
    }

    function addImageFromFileInput(input) {
      if (pendingImages.length >= 5) { showToast('Maximum 5 images per item.', true); return; }
      const file = input.files[0];
      if (!file) return;
      compressImage(file, 800, 0.82).then(compressed => {
        pendingImages.push(compressed);
        input.value = '';
        renderImageThumbs();
      }).catch(() => showToast('Could not load image.', true));
    }

    function removePendingImage(i) {
      pendingImages.splice(i, 1);
      renderImageThumbs();
    }

    function movePendingImage(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= pendingImages.length) return;
      [pendingImages[i], pendingImages[j]] = [pendingImages[j], pendingImages[i]];
      renderImageThumbs();
    }

    // ── CATEGORIES MODAL ───────────────────────────────
    // ── BACKUP RESTORE ──────────────────────────────────
    async function openBackupModal() {
      const overlay = document.getElementById('backup-modal-overlay');
      overlay.classList.add('open');
      await renderBackupList();
      trapFocus(document.getElementById('backup-modal'));
    }
    function closeBackupModal() {
      document.getElementById('backup-modal-overlay').classList.remove('open');
      releaseFocus(document.getElementById('backup-modal'));
    }

    // ── SETTINGS ─────────────────────────────────────────
    function openSettingsModal() {
      _syncSettingsUI();
      document.getElementById('settings-modal-overlay').classList.add('open');
      trapFocus(document.getElementById('settings-modal'));
    }
    function closeSettingsModal() {
      document.getElementById('settings-modal-overlay').classList.remove('open');
      releaseFocus(document.getElementById('settings-modal'));
    }

    // Keeps the Settings panel's controls showing the correct current state.
    // Called on open, and again after toggling any of the preferences it
    // hosts (from Settings itself, or from wherever else that preference
    // also lives — e.g. the header theme toggle, the Categories stat-max
    // button, the toolbar view button — so it never goes stale.
    function _syncSettingsUI() {
      const themeBtn = document.getElementById('settings-theme-btn');
      if (themeBtn) themeBtn.innerHTML = lightMode ? `${Icons.sun} Light` : `${Icons.moon} Dark`;

      const statBtn = document.getElementById('settings-statmax-btn');
      if (statBtn) statBtn.textContent = `Max ${statMax}`;

      const viewBtn = document.getElementById('settings-view-btn');
      if (viewBtn) viewBtn.innerHTML = viewMode === 'list' ? `${Icons.list} List` : `${Icons.grid} Grid`;
    }

    async function clearAllItems() {
      if (!items.length) { showToast('There are no items to clear.', true); return; }
      const n = items.length;
      const confirmed = confirm(
        `Delete all ${n} item${n === 1 ? '' : 's'}?\n\n` +
        'Categories and templates are kept. This cannot be undone from here — ' +
        'export a backup first if you want to keep a copy.'
      );
      if (!confirmed) return;
      items = [];
      compareSet.clear();
      bulkEditSet.clear();
      if (!incognitoMode) await axisSave(items, categories);
      render();
      closeSettingsModal();
      showToast(`Cleared ${n} item${n === 1 ? '' : 's'}.`);
    }

    async function resetEverything() {
      const confirmed = confirm(
        'Reset Axis completely?\n\n' +
        'This deletes ALL items AND categories, with no way to undo it from here. ' +
        'Export a backup first if you want to keep anything.'
      );
      if (!confirmed) return;
      // Require a second, more deliberate confirmation for the most
      // destructive action in the app
      const typed = prompt('Type RESET to confirm — this cannot be undone.');
      if (typed !== 'RESET') { showToast('Reset cancelled.'); return; }

      items = [];
      categories = [];
      compareSet.clear();
      bulkEditSet.clear();
      if (!incognitoMode) await axisSave(items, categories);
      render();
      closeSettingsModal();
      showToast('Axis has been reset.');
    }

    function _formatBackupTimestamp(ts) {
      if (!ts) return { date: 'Unknown date', time: '' };
      const date = ts.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      const time = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return { date, time };
    }

    async function renderBackupList() {
      const list = document.getElementById('backup-list');
      list.innerHTML = '<div class="backup-empty">Loading…</div>';

      if (!AxisStorage.isTauri) {
        list.innerHTML = '<div class="backup-empty">Backups are only available in the desktop app.</div>';
        return;
      }

      const backups = await AxisStorage.listBackups();
      if (!backups.length) {
        list.innerHTML = '<div class="backup-empty">No backups yet. One is created automatically the first time you make a change in a session.</div>';
        return;
      }

      list.innerHTML = '';
      backups.forEach((b, i) => {
        const { date, time } = _formatBackupTimestamp(b.timestamp);
        const row = document.createElement('div');
        row.className = 'backup-row';
        row.innerHTML = `
          <div class="backup-row-info">
            <div class="backup-row-date">${esc(date)}${i === 0 ? '<span class="backup-row-latest">Latest</span>' : ''}</div>
            <div class="backup-row-time">${esc(time)}</div>
          </div>
          <button class="backup-row-restore" aria-label="Restore backup from ${esc(date)} ${esc(time)}" onclick="restoreBackupByName('${esc(b.name).replace(/'/g, "\\'")}')">↺ Restore</button>`;
        list.appendChild(row);
      });
    }

    async function restoreBackupByName(filename) {
      const confirmed = confirm(
        'Restore this backup?\\n\\nThis replaces your CURRENT items and categories. ' +
        'If you have unsaved or unexported changes you want to keep, cancel and export first.'
      );
      if (!confirmed) return;

      const btns = document.querySelectorAll('.backup-row-restore');
      btns.forEach(b => b.disabled = true);

      const data = await AxisStorage.restoreBackup(filename);
      if (!data) {
        showToast('Could not restore that backup.', true);
        btns.forEach(b => b.disabled = false);
        return;
      }

      items      = data.items || [];
      categories = data.categories || [];
      if (!incognitoMode) await axisSave(items, categories);
      render();
      closeBackupModal();
      showToast(`Restored backup — ${items.length} item${items.length === 1 ? '' : 's'} loaded.`);
    }

    // ── PROJECTS ─────────────────────────────────────────
    async function openProjectsModal() {
      document.getElementById('projects-modal-overlay').classList.add('open');
      await renderProjectsList();
      trapFocus(document.getElementById('projects-modal'));
    }
    function closeProjectsModal() {
      document.getElementById('projects-modal-overlay').classList.remove('open');
      releaseFocus(document.getElementById('projects-modal'));
    }

    // ── PROJECT QUICK SWITCHER (Ctrl/Cmd+K) ─────────────
    // A fast, keyboard-first "jump to project" palette — distinct from the
    // Projects modal, which is for managing (rename/delete/create) rather
    // than quickly hopping between projects you already have.
    let _switcherProjects = [];   // full { activeProjectId, projects } cache for the current open
    let _switcherFiltered = [];   // currently-filtered/displayed subset
    let _switcherSelIdx = 0;      // keyboard-selected row index

    async function openProjectSwitcher() {
      if (!AxisStorage.isTauri) { showToast('Projects are only available in the desktop app.', true); return; }
      const { activeProjectId, projects } = await axisListProjects();
      if (projects.length < 2) { showToast('You only have one project.'); return; }

      _switcherProjects = { activeProjectId, projects };
      const overlay = document.getElementById('switcher-overlay');
      const input = document.getElementById('switcher-input');
      overlay.classList.add('open');
      input.value = '';
      _renderSwitcherList('');
      trapFocus(document.getElementById('switcher-box'), 'switcher-input');
    }

    function closeProjectSwitcher() {
      document.getElementById('switcher-overlay').classList.remove('open');
      releaseFocus(document.getElementById('switcher-box'));
    }

    function _renderSwitcherList(query) {
      const q = query.trim().toLowerCase();
      const { activeProjectId, projects } = _switcherProjects;
      _switcherFiltered = !q
        ? projects
        : projects.filter(p => p.name.toLowerCase().includes(q));
      _switcherSelIdx = 0;

      const list = document.getElementById('switcher-list');
      if (!_switcherFiltered.length) {
        list.innerHTML = '<div class="switcher-empty">No matching projects.</div>';
        return;
      }
      list.innerHTML = '';
      list.setAttribute('role', 'listbox');
      _switcherFiltered.forEach((project, i) => {
        const isActive = project.id === activeProjectId;
        const row = document.createElement('div');
        row.className = 'switcher-item' + (i === 0 ? ' selected' : '');
        row.dataset.idx = i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === 0));
        row.innerHTML = `
          <span class="switcher-item-name">${esc(project.name)}</span>
          ${isActive ? '<span class="switcher-item-active">Current</span>' : ''}`;
        row.onclick = () => _switcherChoose(i);
        list.appendChild(row);
      });
    }

    function _switcherMove(delta) {
      if (!_switcherFiltered.length) return;
      _switcherSelIdx = (_switcherSelIdx + delta + _switcherFiltered.length) % _switcherFiltered.length;
      document.querySelectorAll('.switcher-item').forEach(el => {
        const isSel = Number(el.dataset.idx) === _switcherSelIdx;
        el.classList.toggle('selected', isSel);
        el.setAttribute('aria-selected', String(isSel));
      });
      document.querySelector('.switcher-item.selected')?.scrollIntoView({ block: 'nearest' });
    }

    async function _switcherChoose(idx) {
      const project = _switcherFiltered[idx];
      if (!project) return;
      closeProjectSwitcher();
      await axisSwitchProject(project.id);
    }

    function _switcherKeydown(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); _switcherMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); _switcherMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); _switcherChoose(_switcherSelIdx); }
      else if (e.key === 'Escape') { e.preventDefault(); closeProjectSwitcher(); }
    }

    // Keeps the header's small project badge in sync with whichever project
    // is actually active. This is a separate element from the tagline — the
    // tagline text itself never changes, by design (see CLAUDE.md). The badge
    // is hidden entirely when there's no active project name to show (e.g.
    // very first paint, or non-Tauri browser mode where projects don't exist).
    function _updateHeaderProjectName() {
      const el = document.getElementById('header-project-name');
      if (!el) return;
      if (activeProject.name) {
        el.textContent = activeProject.name;
        el.style.display = '';
      } else {
        el.textContent = '';
        el.style.display = 'none';
      }
    }

    function _formatProjectMeta(project) {
      const ts = project.lastOpenedAt || project.createdAt;
      if (!ts) return '';
      const label = project.lastOpenedAt ? 'Opened' : 'Created';
      const date  = new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      return `${label} ${date}`;
    }

    async function renderProjectsList() {
      const list = document.getElementById('projects-list');
      list.innerHTML = '<div class="project-empty">Loading…</div>';

      if (!AxisStorage.isTauri) {
        list.innerHTML = '<div class="project-empty">Projects are only available in the desktop app.</div>';
        return;
      }

      const { activeProjectId, projects } = await axisListProjects();
      if (!projects.length) {
        list.innerHTML = '<div class="project-empty">No projects yet.</div>';
        return;
      }

      list.innerHTML = '';
      projects.forEach(project => {
        const isActive = project.id === activeProjectId;
        const row = document.createElement('div');
        row.className = 'project-row' + (isActive ? ' active' : '');
        const safeId   = esc(project.id).replace(/'/g, "\\'");
        const safeName = esc(project.name).replace(/'/g, "\\'");

        row.innerHTML = `
          <div class="project-row-info">
            <div class="project-row-name">${esc(project.name)}${isActive ? '<span class="project-active-badge">Active</span>' : ''}</div>
            <div class="project-row-meta">${esc(_formatProjectMeta(project))}</div>
          </div>
          <div class="project-row-actions">
            ${isActive ? '' : `<button class="project-btn open" onclick="axisSwitchProject('${safeId}').then(ok => { if (ok) closeProjectsModal(); else renderProjectsList(); })">Open</button>`}
            <button class="project-btn rename" title="Rename" aria-label="Rename ${esc(project.name)}" onclick="_renameProjectPrompt('${safeId}', '${safeName}')">${Icons.edit}</button>
            <button class="project-btn delete" title="Delete" aria-label="Delete ${esc(project.name)}" onclick="_deleteProjectPrompt('${safeId}', '${safeName}')">${Icons.x}</button>
          </div>`;
        list.appendChild(row);
      });
    }

    async function createNewProjectFromInput() {
      const input = document.getElementById('project-new-input');
      const name  = input.value.trim();
      if (!name) { showToast('Enter a project name first.', true); return; }
      const project = await axisCreateProject(name);
      if (!project) return; // axisCreateProject already showed an error toast
      input.value = '';
      closeProjectsModal();
    }

    async function _renameProjectPrompt(id, currentName) {
      const newName = prompt('Rename project:', currentName);
      if (!newName || !newName.trim() || newName.trim() === currentName) return;
      const ok = await axisRenameProject(id, newName.trim());
      if (ok) { _updateHeaderProjectName(); await renderProjectsList(); }
    }

    async function _deleteProjectPrompt(id, name) {
      const confirmed = confirm(
        `Delete "${name}"?\n\n` +
        'This permanently deletes its items, categories, images, and backups. ' +
        'Export a copy first if you want to keep anything.'
      );
      if (!confirmed) return;
      await axisDeleteProject(id);
      await renderProjectsList();
    }

    function openCatModal() {
      renderCatList();
      renderTplList();
      document.getElementById('cat-modal-overlay').classList.add('open');
      trapFocus(document.getElementById('cat-modal'), 'cat-new-input');
    }
    function closeCatModal() {
      document.getElementById('cat-modal-overlay').classList.remove('open');
      releaseFocus(document.getElementById('cat-modal'));
      render();
    }
    function renderCatList() {
      const list = document.getElementById('cat-list');
      list.innerHTML = '';
      if (!categories.length) {
        list.innerHTML = '<div class="cat-empty">No categories yet. Add one below.</div>';
        return;
      }
      categories.forEach((cat, i) => {
        const row = document.createElement('div');
        row.className = 'cat-row';

        // ↑ button
        const upBtn = document.createElement('button');
        upBtn.className = 'cat-reorder-btn';
        upBtn.textContent = '↑';
        upBtn.title = 'Move up';
        upBtn.setAttribute('aria-label', `Move ${cat} up`);
        upBtn.disabled = i === 0;
        upBtn.onclick = () => moveCat(i, i - 1);

        // ↓ button
        const downBtn = document.createElement('button');
        downBtn.className = 'cat-reorder-btn';
        downBtn.textContent = '↓';
        downBtn.title = 'Move down';
        downBtn.setAttribute('aria-label', `Move ${cat} down`);
        downBtn.disabled = i === categories.length - 1;
        downBtn.onclick = () => moveCat(i, i + 1);

        // inline editable name
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'cat-row-edit';
        nameInput.value = cat;
        nameInput.title = 'Click to rename';
        nameInput.setAttribute('aria-label', `Category name: ${cat}`);
        nameInput.addEventListener('blur', () => saveCatRename(i, nameInput.value));
        nameInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
          if (e.key === 'Escape') { nameInput.value = categories[i]; nameInput.blur(); }
        });

        // delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'cat-row-del';
        delBtn.title = 'Remove';
        delBtn.setAttribute('aria-label', `Remove ${cat}`);
        delBtn.innerHTML = Icons.x;
        delBtn.onclick = () => removeCategory(i);

        row.appendChild(upBtn);
        row.appendChild(downBtn);
        row.appendChild(nameInput);
        row.appendChild(delBtn);
        list.appendChild(row);
      });
    }

    function moveCat(fromIdx, toIdx) {
      if (toIdx < 0 || toIdx >= categories.length) return;
      const [moved] = categories.splice(fromIdx, 1);
      categories.splice(toIdx, 0, moved);
      save();
      renderCatList();
      renderSortBar();
    }

    function saveCatRename(index, newName) {
      const trimmed = newName.trim();
      if (!trimmed) {
        // empty — revert
        renderCatList(); return;
      }
      const oldName = categories[index];
      if (trimmed === oldName) return; // no change
      if (categories.some((c, i) => i !== index && c.toLowerCase() === trimmed.toLowerCase())) {
        showToast('That category name already exists.', true);
        renderCatList(); return;
      }
      // rename in all items' stats
      items.forEach(item => {
        if (item.stats && oldName in item.stats) {
          item.stats[trimmed] = item.stats[oldName];
          delete item.stats[oldName];
        }
      });
      // fix active sort
      if (currentSort.cat === oldName) currentSort.cat = trimmed;
      categories[index] = trimmed;
      save();
      renderSortBar();
      renderGrid();
    }
    function addCategory() {
      const input = document.getElementById('cat-new-input');
      const name = input.value.trim();
      if (!name) return;
      if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
        showToast('Category already exists.', true); return;
      }
      categories.push(name);
      input.value = '';
      save();
      renderCatList();
      renderSortBar();
      renderGrid();
    }
    function removeCategory(index) {
      const name = categories[index];
      if (items.some(item => item.stats?.[name] !== undefined)) {
        if (!confirm(`Removing "${name}" will delete its values from all items. Continue?`)) return;
        items.forEach(item => { if (item.stats) delete item.stats[name]; });
      }
      categories.splice(index, 1);
      if (currentSort.cat === name) currentSort = { cat: 'overall', dir: 'desc' };
      save();
      renderCatList();
      render();
    }

    // ── EXPORT SUBMENU (hamburger drawer) ───────────────────
    function toggleHamExportMenu(e) {
      if (e) e.stopPropagation();
      document.getElementById('ham-export-menu')?.classList.toggle('open');
    }
    function closeHamExportMenu() {
      document.getElementById('ham-export-menu')?.classList.remove('open');
    }
    document.addEventListener('click', () => closeHamExportMenu());

    function toggleShareFormatMenu(e) {
      if (e) e.stopPropagation();
      const menu = document.getElementById('share-format-menu');
      const btn  = document.getElementById('overall-share-btn');
      if (!menu || !btn) return;
      const isOpen = menu.classList.contains('open');
      if (isOpen) {
        menu.classList.remove('open');
        return;
      }
      // Anchor via fixed coordinates (not CSS position:absolute) so the
      // popover isn't clipped by #overall-section's overflow:hidden
      const r = btn.getBoundingClientRect();
      menu.style.top   = `${r.bottom + 5}px`;
      menu.style.left  = `${r.right - menu.offsetWidth}px`;
      menu.classList.add('open');
      // offsetWidth above may read 0 the very first time (display:none until
      // just now) — reposition on the next frame once it has real dimensions
      requestAnimationFrame(() => {
        menu.style.left = `${r.right - menu.offsetWidth}px`;
      });
    }
    function closeShareFormatMenu() {
      document.getElementById('share-format-menu')?.classList.remove('open');
    }
    document.addEventListener('click', () => closeShareFormatMenu());
    window.addEventListener('scroll', () => closeShareFormatMenu(), true);

    // ── HAMBURGER MENU ─────────────────────────────────────
    function openHamMenu() {
      document.getElementById('ham-overlay').classList.add('open');
      document.getElementById('ham-drawer').classList.add('open');
      trapFocus(document.getElementById('ham-drawer'));
    }
    function closeHamMenu() {
      closeHamExportMenu();
      document.getElementById('ham-overlay').classList.remove('open');
      document.getElementById('ham-drawer').classList.remove('open');
      releaseFocus(document.getElementById('ham-drawer'));
    }
    // Close on Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeHamMenu();
        closeShareFormatMenu();
      }
    });

    // ── IMPORT / EXPORT ────────────────────────────────
    async function exportJSON() {
      const msg = await axisExportJSON(items, categories);
      if (msg) showToast(msg);
    }
    async function exportZip() {
      const msg = await axisExportZip(items, categories);
      if (msg) showToast(msg);
    }
    async function exportXLSX() {
      const msg = await axisExportXLSX(items, categories);
      if (msg) showToast(msg);
    }
    function importData() { document.getElementById('import-input').click(); }
    async function handleImport(input) {
      const file = input.files[0]; if (!file) return;
      input.value = '';
      showToast('Importing…');
      try {
        const { items: newItems, categories: newCats } = await axisParseImport(file);
        if (!newItems?.length && !newCats?.length) throw new Error('Empty or bad format');
        const doMerge = items.length
          ? confirm(`Merge ${newItems.length} items into your existing ${items.length}?\nCancel = replace all`)
          : false;
        if (doMerge) {
          // Merges dedupe by id (exact re-import of something exported from
          // this same project) — but imports from formats with no id column
          // (XLSX, CSV-shaped data) always get freshly generated ids, so an
          // id-only check would silently create name duplicates every time.
          // Catch that case up front and let the person decide once, rather
          // than finding a pile of "Batman" x2 after the fact.
          const existingIds   = new Set(items.map(c => c.id));
          const existingNames = new Set(items.map(c => c.name.toLowerCase()));
          const incoming = newItems.filter(c => !existingIds.has(c.id));
          const nameCollisions = incoming.filter(c => existingNames.has(c.name.toLowerCase()));

          let skipNames = new Set();
          if (nameCollisions.length) {
            const sample = nameCollisions.slice(0, 5).map(c => `"${c.name}"`).join(', ');
            const more = nameCollisions.length > 5 ? ` and ${nameCollisions.length - 5} more` : '';
            const skipDuplicates = confirm(
              `${nameCollisions.length} incoming item${nameCollisions.length === 1 ? '' : 's'} share${nameCollisions.length === 1 ? 's' : ''} a name with something you already have (${sample}${more}).\n\n` +
              `OK = skip those, keep only the rest\nCancel = add them anyway as separate items`
            );
            if (skipDuplicates) skipNames = new Set(nameCollisions.map(c => c.name.toLowerCase()));
          }

          let addedCount = 0;
          let skippedCount = 0;
          incoming.forEach(c => {
            if (skipNames.has(c.name.toLowerCase())) { skippedCount++; return; }
            items.push(c);
            addedCount++;
          });
          newCats.forEach(k => { if (!categories.includes(k)) categories.push(k); });
          save(); render();
          showToast(`Imported ${addedCount} item${addedCount !== 1 ? 's' : ''}.` + (skippedCount ? ` Skipped ${skippedCount} duplicate${skippedCount === 1 ? '' : 's'}.` : ''));
        } else {
          items = newItems; categories = newCats;
          save(); render();
          showToast(`Imported ${newItems.length} item${newItems.length !== 1 ? 's' : ''}.`);
        }
      } catch (e) {
        console.error('[Axis] import error:', e);
        showToast('Import failed — invalid Axis file.', true);
      }
    }

    // ── ZIP BUILDER ────────────────────────────────────
    function buildZip(entries) {
      const enc = new TextEncoder(), cd = [], parts = [];
      let off = 0;
      entries.forEach(e => {
        const nb = enc.encode(e.name), db = enc.encode(e.data), crc = crc32(db);
        const lh = makeLocalHeader(nb, db.length, crc);
        cd.push({ nb, size: db.length, crc, off });
        parts.push(lh, db); off += lh.length + db.length;
      });
      const cdp = cd.map(e => makeCDEntry(e.nb, e.size, e.crc, e.off));
      const cds = cdp.reduce((a, b) => a + b.length, 0);
      return concat([...parts, ...cdp, makeEOCD(cd.length, cds, off)]);
    }
    function makeLocalHeader(nb, sz, crc) {
      const b = new Uint8Array(30 + nb.length), v = new DataView(b.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true);
      v.setUint32(14, crc, true); v.setUint32(18, sz, true); v.setUint32(22, sz, true); v.setUint16(26, nb.length, true);
      b.set(nb, 30); return b;
    }
    function makeCDEntry(nb, sz, crc, off) {
      const b = new Uint8Array(46 + nb.length), v = new DataView(b.buffer);
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true);
      v.setUint32(16, crc, true); v.setUint32(20, sz, true); v.setUint32(24, sz, true);
      v.setUint16(28, nb.length, true); v.setUint32(42, off, true);
      b.set(nb, 46); return b;
    }
    function makeEOCD(cnt, cds, cdo) {
      const b = new Uint8Array(22), v = new DataView(b.buffer);
      v.setUint32(0, 0x06054b50, true); v.setUint16(8, cnt, true); v.setUint16(10, cnt, true);
      v.setUint32(12, cds, true); v.setUint32(16, cdo, true); return b;
    }
    function concat(arrs) {
      const t = arrs.reduce((a, b) => a + b.length, 0), out = new Uint8Array(t); let o = 0;
      arrs.forEach(a => { out.set(a, o); o += a.length; }); return out;
    }
    function crc32(data) {
      const tbl = crc32.t || (crc32.t = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
        return t;
      })());
      let c = 0xffffffff;
      for (let i = 0; i < data.length; i++) c = tbl[(c ^ data[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    }
    function dl(blob, filename) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }


    // ── BULK IMAGE IMPORT ──────────────────────────────
    let bulkQueue = []; // processed items waiting to be confirmed

    function bulkImportTrigger() {
      document.getElementById('bulk-input').click();
    }

    function handleBulkImport(input) {
      const files = [...input.files];
      if (!files.length) return;
      input.value = '';

      bulkQueue = [];
      const overlay = document.getElementById('bulk-overlay');
      const grid = document.getElementById('bulk-preview-grid');
      const statusEl = document.getElementById('bulk-status');
      const bar = document.getElementById('bulk-progress-bar');
      const confirmBtn = document.getElementById('bulk-confirm-btn');
      const cancelBtn = document.getElementById('bulk-cancel-btn');

      grid.innerHTML = '';
      bar.style.width = '0%';
      statusEl.textContent = `Processing 0 / ${files.length}...`;
      confirmBtn.style.display = 'none';
      cancelBtn.textContent = 'Cancel';
      overlay.style.display = 'flex';
      trapFocus(document.getElementById('bulk-modal'));

      let done = 0;

      files.forEach((file, i) => {
        // Derive name from filename: remove extension, replace hyphens/underscores with spaces, title-case
        const rawName = file.name.replace(/\.[^.]+$/, '');
        const name = rawName
          .replace(/[-_]/g, ' ')
          .replace(/\w/g, c => c.toUpperCase())
          .trim() || `Item ${i + 1}`;

        // Create thumb placeholder
        const thumb = document.createElement('div');
        thumb.className = 'bulk-thumb';
        thumb.id = `bulk-thumb-${i}`;
        thumb.innerHTML = `<div class="bulk-thumb-loading">${Icons.image}</div>
      <div class="bulk-thumb-name">${esc(name)}</div>`;
        grid.appendChild(thumb);

        // Compress image
        compressImage(file, 800, 0.82).then(b64 => {
          thumb.innerHTML = `<img src="${b64}" alt="${esc(name)}"><div class="bulk-thumb-name">${esc(name)}</div>`;
          thumb.classList.add('done');
          bulkQueue.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + i,
            name, img: b64, bio: '',
            stats: {}, tags: [], createdAt: Date.now()
          });
          done++;
          bar.style.width = `${Math.round(done / files.length * 100)}%`;
          statusEl.textContent = done < files.length
            ? `Processing ${done} / ${files.length}...`
            : `${done} image${done > 1 ? 's' : ''} ready — review below`;
          if (done === files.length) {
            confirmBtn.textContent = `Add ${done} Item${done > 1 ? 's' : ''}`;
            confirmBtn.style.display = 'inline-block';
            cancelBtn.textContent = 'Discard';
          }
        }).catch(() => {
          thumb.classList.add('error');
          thumb.innerHTML += `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.6rem;color:var(--danger);">ERR</div>`;
          done++;
          bar.style.width = `${Math.round(done / files.length * 100)}%`;
          if (done === files.length) {
            statusEl.textContent = `Done (some files failed)`;
            if (bulkQueue.length) {
              confirmBtn.textContent = `Add ${bulkQueue.length} Item${bulkQueue.length > 1 ? 's' : ''}`;
              confirmBtn.style.display = 'inline-block';
            }
            cancelBtn.textContent = 'Discard';
          }
        });
      });
    }

    function confirmBulkImport() {
      if (!bulkQueue.length) { closeBulkModal(); return; }
      // Default stats to 5 for all categories
      bulkQueue.forEach(item => {
        const stats = {};
        categories.forEach(k => { stats[k] = 5; });
        item.stats = stats;
        items.push(item);
      });
      save();
      render();
      showToast(`Added ${bulkQueue.length} item${bulkQueue.length > 1 ? 's' : ''}. Edit each to set stats.`);
      closeBulkModal();
    }

    function closeBulkModal() {
      document.getElementById('bulk-overlay').style.display = 'none';
      releaseFocus(document.getElementById('bulk-modal'));
      bulkQueue = [];
    }

    // Shared image compression helper (used by both single + bulk upload)
    function compressImage(file, maxPx, quality) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = e => {
          const img = new Image();
          img.onerror = reject;
          img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxPx || h > maxPx) {
              if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
              else { w = Math.round(w * maxPx / h); h = maxPx; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      });
    }


    // ── TAGS ───────────────────────────────────────────
    function handleTagInput(e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = e.target.value.trim().replace(/,$/, '');
        addPendingTag(val);
        e.target.value = '';
      } else if (e.key === 'Backspace' && !e.target.value && pendingTags.length) {
        pendingTags.pop();
        renderTagInputChips();
      }
    }
    function addPendingTag(val) {
      if (!val) return;
      const clean = val.trim();
      if (!clean || pendingTags.includes(clean)) return;
      pendingTags.push(clean);
      renderTagInputChips();
    }
    function removePendingTag(i) {
      pendingTags.splice(i, 1);
      renderTagInputChips();
    }
    function renderTagInputChips() {
      const wrap = document.getElementById('tag-input-wrap');
      const inp = document.getElementById('tag-text-input');
      // Remove old chips, keep the input
      wrap.querySelectorAll('.tag-chip').forEach(c => c.remove());
      pendingTags.forEach((tag, i) => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.innerHTML = `${esc(tag)}<button type="button" class="tag-x" aria-label="Remove tag ${esc(tag)}" onclick="removePendingTag(${i})">${Icons.x}</button>`;
        wrap.insertBefore(chip, inp);
      });
    }

    function getAllTags() {
      const set = new Set();
      items.forEach(item => (item.tags || []).forEach(t => set.add(t)));
      return [...set].sort();
    }

    function renderTagFilterBar() {
      const bar = document.getElementById('tag-filter-bar');
      const tags = getAllTags();
      if (!tags.length) { bar.classList.remove('visible'); return; }
      bar.classList.add('visible');
      // rebuild keeping the label
      bar.innerHTML = '<span>Tags:</span>';
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'tag-chip interactive' + (!activeTagFilter ? ' active' : '');
      allBtn.textContent = 'All';
      allBtn.setAttribute('aria-pressed', String(!activeTagFilter));
      allBtn.onclick = () => setTagFilter('');
      bar.appendChild(allBtn);
      tags.forEach(tag => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tag-chip interactive' + (activeTagFilter === tag ? ' active' : '');
        chip.textContent = tag;
        chip.setAttribute('aria-pressed', String(activeTagFilter === tag));
        chip.setAttribute('aria-label', `Filter by tag ${tag}`);
        chip.onclick = () => setTagFilter(tag === activeTagFilter ? '' : tag);
        bar.appendChild(chip);
      });
    }
    function setTagFilter(tag) {
      activeTagFilter = tag;
      renderTagFilterBar();
      renderGrid();
      const countEl = document.getElementById('search-count');
      if (tag) countEl.textContent = `tag: ${tag}`;
      else if (!searchQuery) countEl.textContent = '';
    }

    // ── STATS BAR ──────────────────────────────────────
    function renderStatsBar() {
      const bar = document.getElementById('stats-bar');
      if (!items.length) {
        bar.classList.remove('visible');
        bar.innerHTML = '';
        return;
      }
      bar.classList.add('visible');

      const totalStorage = items.reduce((sum, item) => {
        let bytes = 0;
        if (item.img?.startsWith('data:')) bytes += item.img.length * 0.75;
        if (item.img2?.startsWith('data:')) bytes += item.img2.length * 0.75;
        if (item.img3?.startsWith('data:')) bytes += item.img3.length * 0.75;
        if (item.img4?.startsWith('data:')) bytes += item.img4.length * 0.75;
        if (item.img5?.startsWith('data:')) bytes += item.img5.length * 0.75;
        return sum + Math.round(bytes / 1024);
      }, 0);
      const storageStr = totalStorage > 1024
        ? (totalStorage / 1024).toFixed(1) + 'MB'
        : totalStorage + 'KB';

      const avgScore = items.length
        ? (items.reduce((s, i) => s + overallScore(i), 0) / items.length).toFixed(1)
        : '—';

      const allTags = getAllTags();

      bar.innerHTML = `
    <div class="stats-bar-item"><div class="stats-bar-val">${items.length}</div><div class="stats-bar-label">Items</div></div>
    <div class="stats-bar-item"><div class="stats-bar-val">${categories.length}</div><div class="stats-bar-label">Categories</div></div>
    <div class="stats-bar-item"><div class="stats-bar-val">${allTags.length}</div><div class="stats-bar-label">Tags</div></div>
    <div class="stats-bar-item"><div class="stats-bar-val">${avgScore}<span style="font-size:.6em;opacity:.6;font-weight:400">/${statMax}</span></div><div class="stats-bar-label">Avg Score</div></div>
    <div class="stats-bar-item"><div class="stats-bar-val">${storageStr}</div><div class="stats-bar-label">Images</div></div>
  `;
    }

    // ── FULLSCREEN VIEWER ──────────────────────────────
    let viewerScale = 1;
    function openViewer(src) {
      viewerScale = 1;
      const img = document.getElementById('viewer-img');
      img.src = src;
      img.style.transform = 'scale(1)';
      const overlay = document.getElementById('viewer-overlay');
      overlay.classList.add('open');
      trapFocus(overlay);
    }
    function closeViewer(e) {
      const overlay = document.getElementById('viewer-overlay');
      if (e && e.target !== overlay) return;
      overlay.classList.remove('open');
      releaseFocus(overlay);
    }
    function viewerZoom(delta) {
      viewerScale = Math.max(0.5, Math.min(5, viewerScale + delta));
      document.getElementById('viewer-img').style.transform = `scale(${viewerScale})`;
    }
    function viewerZoomReset() {
      viewerScale = 1;
      document.getElementById('viewer-img').style.transform = 'scale(1)';
    }
    // scroll to zoom
    document.getElementById('viewer-overlay').addEventListener('wheel', e => {
      e.preventDefault();
      viewerZoom(e.deltaY < 0 ? 0.15 : -0.15);
    }, { passive: false });

    // ── (file drag-drop removed — not supported in Tauri webview) ────

    // ── LIST VIEW ──────────────────────────────────────
    let viewMode = 'grid';

    // Fade the grid out, swap DOM to the new view mode, fade it back in.
    // See the '#grid.view-switching' comment in styles.css for why this is
    // a container-level crossfade rather than the per-item FLIP glide used
    // for reordering/filtering — grid cards and list rows don't share a
    // layout a single element could animate between.
    function toggleView() {
      viewMode = viewMode === 'grid' ? 'list' : 'grid';
      const grid = document.getElementById('grid');

      if (_reducedMotion || !grid) {
        renderGrid();
        renderSortBar();
        axisSaveSettings({ viewMode });
        return;
      }

      grid.classList.add('view-switching');
      setTimeout(() => {
        renderGrid();
        renderSortBar();
        // Force a reflow so the browser registers the new (still-hidden)
        // layout before we remove the class, otherwise the fade-in gets
        // batched with the DOM swap and never actually plays.
        void grid.offsetWidth;
        grid.classList.remove('view-switching');
      }, 120);
      axisSaveSettings({ viewMode });
    }

    function renderListView(sorted, prevRects) {
      const grid = document.getElementById('grid');
      grid.classList.add('list-mode');
      sorted.forEach(item => {
        const row = document.createElement('div');
        const tier = scoreTier(item);
        row.className = 'lrow' + (compareSet.has(item.id) ? ' selected' : '') + (bulkEditSet.has(item.id) ? ' bulk-selected' : '') + (tier ? ' ' + tier : '');
        row.dataset.id = item.id;

        const _lsrc = axisImgSrc(item.img);
        const imgEl = _lsrc
          ? `<img class="lrow-img" src="${esc(_lsrc)}" alt="${esc(item.name)}" loading="lazy">`
          : `<div class="lrow-img-ph">◈</div>`;

        const statsHtml = categories.map(k => {
          const v = item.stats?.[k] ?? 0;
          return `<div class="lrow-stat">
        <div class="lrow-stat-label">${esc(k)}</div>
        <div class="lrow-stat-val">${v}</div>
      </div>`;
        }).join('');

        const selIdx = [...compareSet].indexOf(item.id);

        row.innerHTML = `
      <div class="bulk-checkbox">${Icons.check}</div>
      ${imgEl}
      <div class="lrow-name">${esc(item.name)}</div>
      <div class="lrow-stats">${statsHtml || '<span style="font-size:.75rem;color:var(--muted);">No stats</span>'}</div>
      <div class="lrow-overall">${overallScore(item).toFixed(1)}</div>
      <div class="lrow-actions">
        <button class="card-action-btn edit" title="Compare" aria-label="Select ${esc(item.name)} for compare" onclick="toggleCompare('${item.id}',event)">${Icons.swap}</button>
        <button class="card-action-btn edit" title="Edit" aria-label="Edit ${esc(item.name)}" onclick="event.stopPropagation();openEditModal('${item.id}')">${Icons.edit}</button>
        <button class="card-action-btn del"  title="Delete" aria-label="Delete ${esc(item.name)}" onclick="event.stopPropagation();deleteItem('${item.id}')">${Icons.trash}</button>
      </div>`;

        row.onclick = () => {
          if (bulkEditMode) { toggleBulkSelect(item.id); return; }
          openPanel(item.id);
        };
        makeKeyboardClickable(row, `${item.name}, score ${overallScore(item).toFixed(1)}`);
        grid.appendChild(row);
      });
      grid.appendChild(makeAddCard());
      playFlipAnimation(grid, prevRects);
    }



    // ── DUPLICATE ITEM ─────────────────────────────────
    function duplicateItem(id) {
      const src = items.find(x => x.id === id);
      if (!src) return;
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      copy.name = src.name + ' (Copy)';
      copy.createdAt = Date.now();
      const srcIdx = items.findIndex(x => x.id === id);
      items.splice(srcIdx + 1, 0, copy);
      save(); render();
      showToast(`Duplicated "${src.name}".`);
    }


    // ── CATEGORY TEMPLATES ─────────────────────────────
    let templates = {}; // { name: [cat, ...] }

    function loadTemplates() {
      try { const r = localStorage.getItem('axis_tpl'); if (r) templates = JSON.parse(r); }
      catch (e) { templates = {}; }
      _seedStarterTemplateOnce();
    }

    // Gives brand new installs a one-click way to see the category/template
    // system in action instead of facing a totally blank slate. Only ever
    // runs once per install — tracked by a flag, not by "is templates empty"
    // — so it doesn't come back if someone deletes the starter template.
    function _seedStarterTemplateOnce() {
      try {
        if (localStorage.getItem('axis_seeded_starter')) return;
        localStorage.setItem('axis_seeded_starter', '1');
        if (Object.keys(templates).length) return; // don't clobber existing templates
        templates['Video Games'] = ['Graphics', 'Story', 'Gameplay', 'Replayability'];
        templates['Movies']      = ['Acting', 'Plot', 'Visuals', 'Rewatchability'];
        templates['Restaurants'] = ['Taste', 'Price', 'Service', 'Ambiance'];
        saveTemplatesStore();
      } catch (e) { /* silent — onboarding nicety, not critical */ }
    }
    function saveTemplatesStore() {
      try { localStorage.setItem('axis_tpl', JSON.stringify(templates)); } catch (e) { }
    }
    function renderTplList() {
      const list = document.getElementById('tpl-list');
      if (!list) return;
      list.innerHTML = '';
      const names = Object.keys(templates);
      if (!names.length) {
        list.innerHTML = '<div id="tpl-empty">No templates yet. Save your current categories as a template.</div>';
        return;
      }
      names.forEach(name => {
        const cats = templates[name] || [];
        const row = document.createElement('div');
        row.className = 'tpl-row';
        row.innerHTML = `
      <div class="tpl-row-info">
        <div class="tpl-row-name">${esc(name)}</div>
        <div class="tpl-row-cats">${cats.map(esc).join(' · ')}</div>
      </div>
      <button class="tpl-btn load" aria-label="Load ${esc(name)} template" onclick="loadTemplate('${esc(name).replace(/'/g, "\\'")}')">Load</button>
      <button class="tpl-btn del"  title="Delete" aria-label="Delete ${esc(name)} template" onclick="deleteTpl('${esc(name).replace(/'/g, "\\'")}')">${Icons.x}</button>`;
        list.appendChild(row);
      });
    }
    function saveAsTemplate() {
      if (!categories.length) { showToast('No categories to save.', true); return; }
      const name = prompt('Name this template:');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      if (templates[trimmed] && !confirm(`"${trimmed}" already exists. Overwrite?`)) return;
      templates[trimmed] = [...categories];
      saveTemplatesStore();
      renderTplList();
      showToast(`Template "${trimmed}" saved.`);
    }
    function loadTemplate(name) {
      const tpl = templates[name];
      if (!tpl) return;
      if (categories.length) {
        const choice = confirm(`Load template "${name}"?\n\nOK = replace current categories\nCancel = merge (add missing)`);
        if (choice) { categories = [...tpl]; }
        else { tpl.forEach(c => { if (!categories.includes(c)) categories.push(c); }); }
      } else {
        categories = [...tpl];
      }
      save(); renderCatList(); renderTplList();
      showToast(`Template "${name}" loaded.`);
    }
    function deleteTpl(name) {
      if (!confirm(`Delete template "${name}"?`)) return;
      delete templates[name];
      saveTemplatesStore(); renderTplList();
    }


    // ── THEME TOGGLE ───────────────────────────────────
    function toggleTheme() {
      lightMode = !lightMode;
      document.body.classList.toggle('light', lightMode);
      const btn = document.getElementById('theme-toggle-btn');
      const emoji = btn?.querySelector('.tt-emoji');
      const label = document.getElementById('tt-label');
      if (emoji) emoji.innerHTML = lightMode ? Icons.sun : Icons.moon;
      if (label) label.textContent = lightMode ? 'Light' : 'Dark';
      if (btn) btn.title = lightMode ? 'Switch to dark mode' : 'Switch to light mode';
      axisSaveSettings({ theme: lightMode ? 'light' : 'dark' });
      _syncSettingsUI();
    }

    // ── STAT MAX TOGGLE ────────────────────────────────
    // statMax is per-project, saved as part of this project's data.json via
    // axisSave (same place items/categories live) — not settings.json.
    function toggleStatMax() {
      statMax = statMax === 10 ? 100 : 10;
      const btn = document.getElementById('stat-max-btn');
      if (btn) btn.textContent = `Max Stat: ${statMax}`;
      // rebuild stat fields if modal open
      if (document.getElementById('modal-overlay').classList.contains('open')) {
        const current = {};
        document.querySelectorAll('#stat-fields .stat-field-row').forEach(row => {
          const numIn = row.querySelector('.range-num');
          const range = row.querySelector('input[type=range]');
          if (row.dataset.cat) current[row.dataset.cat] = parseFloat(numIn?.value ?? range?.value ?? 0);
        });
        buildStatFields(current);
      }
      updateScoreFilterInputs();
      renderGrid(); renderOverall(); renderStatsBar();
      save();
      showToast(`Max stat set to ${statMax}`);
      _syncSettingsUI();
    }


    /**
     * Resolve an item's `img` field to something safe for <img src="...">.
     * - base64 data URLs and http(s) URLs pass through unchanged
     * - bare filenames (e.g. "img_abc123.jpg" from old imports without Tauri,
     *   or disk-only refs that never got expanded) resolve to '' so we show
     *   the placeholder instead of a broken image icon
     */

    // ── SCORE TIER ─────────────────────────────────────
    // Tiers are relative to the CURRENT set of items (percentile rank), not a
    // fixed absolute ratio of statMax. This keeps the colour-coding meaningful
    // regardless of whether everyone tends to score high, low, or clustered —
    // the top third always reads as "high", bottom third as "low", no matter
    // what the actual numbers look like.
    let _scoreTierMap = new Map();

    function computeScoreTiers() {
      _scoreTierMap = new Map();
      if (!categories.length || items.length < 2) return;
      const scored = items
        .map(it => ({ id: it.id, score: overallScore(it) }))
        .sort((a, b) => a.score - b.score);
      const n = scored.length;
      scored.forEach((entry, i) => {
        const percentile = (i + 1) / n; // higher = better-ranked
        const tier = percentile > 2 / 3 ? 'tier-high'
          : percentile > 1 / 3 ? 'tier-mid'
            : 'tier-low';
        _scoreTierMap.set(entry.id, tier);
      });
    }

    function scoreTier(item) {
      return _scoreTierMap.get(item.id) || '';
    }

    // ── SCORE RANGE FILTER ─────────────────────────────
    function syncScoreFilterUI() {
      const minEl = document.getElementById('sf-min-range');
      const maxEl = document.getElementById('sf-max-range');
      const display = document.getElementById('sf-display');
      const step = statMax <= 10 ? 0.5 : 1;
      if (minEl) {
        minEl.max = statMax;
        minEl.step = step;
        minEl.value = scoreFilterMin;
      }
      if (maxEl) {
        maxEl.max = statMax;
        maxEl.step = step;
        maxEl.value = scoreFilterMax;
      }
      const fill = document.getElementById('sf-track-fill');
      if (fill && statMax > 0) {
        fill.style.left = (scoreFilterMin / statMax * 100) + '%';
        fill.style.width = ((scoreFilterMax - scoreFilterMin) / statMax * 100) + '%';
      }
      const active = scoreFilterMin > 0 || scoreFilterMax < statMax;
      if (display) {
        display.textContent = active
          ? `${scoreFilterMin.toFixed(statMax <= 10 ? 1 : 0)} – ${scoreFilterMax.toFixed(statMax <= 10 ? 1 : 0)}`
          : 'All scores';
        display.classList.toggle('inactive', !active);
      }
    }

    function renderScoreFilterBar() {
      if (!categories.length || items.length < 2) closeScoreFilterPanel();
      syncScoreFilterUI();
    }

    function toggleScoreFilter() {
      const bar = document.getElementById('score-filter-bar');
      const btn = document.getElementById('score-filter-toggle-btn');
      const isOpen = bar.classList.toggle('visible');
      if (btn) btn.classList.toggle('active', isOpen);
      if (isOpen) syncScoreFilterUI();
    }

    function onSfMinInput() {
      const minEl = document.getElementById('sf-min-range');
      const maxEl = document.getElementById('sf-max-range');
      if (parseFloat(minEl.value) > parseFloat(maxEl.value)) minEl.value = maxEl.value;
      applyScoreFilter();
    }

    function onSfMaxInput() {
      const minEl = document.getElementById('sf-min-range');
      const maxEl = document.getElementById('sf-max-range');
      if (parseFloat(maxEl.value) < parseFloat(minEl.value)) maxEl.value = minEl.value;
      applyScoreFilter();
    }

    function applyScoreFilter() {
      const minEl = document.getElementById('sf-min-range');
      const maxEl = document.getElementById('sf-max-range');
      scoreFilterMin = parseFloat(minEl.value) || 0;
      const parsedMax = parseFloat(maxEl.value);
      scoreFilterMax = isNaN(parsedMax) ? statMax : parsedMax;
      if (scoreFilterMax > statMax) { maxEl.value = statMax; scoreFilterMax = statMax; }
      if (scoreFilterMin < 0) { minEl.value = 0; scoreFilterMin = 0; }
      syncScoreFilterUI();
      renderGrid();
    }

    function resetScoreFilter() {
      scoreFilterMin = 0;
      scoreFilterMax = statMax;
      syncScoreFilterUI();
      renderGrid();
    }

    function updateScoreFilterInputs() {
      scoreFilterMax = statMax;
      scoreFilterMin = Math.min(scoreFilterMin, statMax);
      syncScoreFilterUI();
    }

    // ── PIN ITEM ───────────────────────────────────────
    function pinItem(id) {
      const item = items.find(x => x.id === id);
      if (!item) return;
      item.pinned = !item.pinned;
      save(); render();
      // update pin button label in open panel
      const btn = document.getElementById('panel-pin-btn');
      if (btn) btn.innerHTML = `${Icons.pin} ${item.pinned ? 'Unpin' : 'Pin'}`;
      showToast(item.pinned ? `"${item.name}" pinned.` : `"${item.name}" unpinned.`);
    }

    function axisImgSrc(img) {
      if (!img) return '';
      if (img.startsWith('data:') || img.startsWith('http')) return img;
      return ''; // unresolved filename ref — show placeholder
    }



    // ── PANEL IMAGE CAROUSEL ───────────────────────────
    function _renderPanelCarousel() {
      const img = document.getElementById('panel-carousel-img');
      const ph = document.getElementById('panel-carousel-ph');
      const prev = document.getElementById('panel-carousel-prev');
      const next = document.getElementById('panel-carousel-next');
      const counter = document.getElementById('panel-carousel-counter');
      const total = _panelImgs.length;

      if (total === 0) {
        img.style.display = 'none';
        ph.style.display = 'flex';
        prev.style.display = next.style.display = counter.style.display = 'none';
        return;
      }
      const src = _panelImgs[_panelImgIdx];
      img.src = src;
      img.style.display = 'block';
      ph.style.display = 'none';
      prev.style.display = total > 1 ? 'block' : 'none';
      next.style.display = total > 1 ? 'block' : 'none';
      counter.style.display = total > 1 ? 'block' : 'none';
      counter.textContent = `${_panelImgIdx + 1} / ${total}`;
      // dim nav if at edges
      prev.style.opacity = _panelImgIdx === 0 ? '.35' : '1';
      next.style.opacity = _panelImgIdx === total - 1 ? '.35' : '1';
    }
    function togglePanelBio() {
      const wrap = document.getElementById('panel-bio-wrap');
      const btn  = document.getElementById('panel-bio-toggle');
      const collapsing = !wrap.classList.contains('collapsed');
      wrap.classList.toggle('collapsed', collapsing);
      btn.textContent = collapsing ? 'Read more ▾' : 'Show less ▴';
    }

    function panelImgNav(dir) {
      const total = _panelImgs.length;
      _panelImgIdx = Math.max(0, Math.min(total - 1, _panelImgIdx + dir));
      _renderPanelCarousel();
      // Keep the fullscreen viewer in sync if it's currently showing this
      // carousel — so ‹ › (or arrow keys) work the same way in both places.
      const viewerOverlay = document.getElementById('viewer-overlay');
      if (viewerOverlay.classList.contains('open')) {
        viewerScale = 1;
        const vimg = document.getElementById('viewer-img');
        vimg.src = _panelImgs[_panelImgIdx];
        vimg.style.transform = 'scale(1)';
      }
    }

    // ── SHARE AS IMAGE ─────────────────────────────────
    function shareItemAsImage(item) {
      const W       = 480;
      const PAD     = 22;
      const MAX_H   = 680;   // cap for very tall portraits
      const MIN_H   = 380;   // floor for very wide landscapes

      const visStats = categories.slice(0, 8);
      const N        = visStats.length;

      // How much vertical space the stats block needs
      const STAT_ROW_H = N > 0 ? Math.min(34, Math.max(24, Math.floor(180 / N))) : 30;
      const STATS_BLOCK = N * STAT_ROW_H + 90; // +90 for name/score/divider/footer

      // Fixed palette — always dark so the output looks sharp regardless of theme
      const C_BG     = '#09090d';
      const C_ACCENT = '#d94f5c';
      const C_WHITE  = '#ffffff';
      const C_LABEL  = 'rgba(255,255,255,0.54)';
      const C_TRACK  = 'rgba(255,255,255,0.12)';
      const C_DIV    = 'rgba(255,255,255,0.14)';
      const C_DIM    = 'rgba(255,255,255,0.22)';

      function build(imgEl) {
        // ── 1. Compute canvas height ─────────────────────────────────────────
        let H;
        if (imgEl) {
          // Natural fit height at W-wide
          const naturalH = Math.round(W * imgEl.naturalHeight / imgEl.naturalWidth);
          H = Math.min(MAX_H, Math.max(MIN_H, naturalH));
        } else {
          H = 520;
        }

        // Canvas setup
        const canvas = document.createElement('canvas');
        const DPR = Math.max(1, Math.round(window.devicePixelRatio || 1));
        canvas.width  = W * DPR;
        canvas.height = H * DPR;
        const ctx = canvas.getContext('2d');
        ctx.scale(DPR, DPR);

        // ── Helpers ──────────────────────────────────────────────────────────
        function box(x, y, w, h, c) {
          ctx.fillStyle = c;
          ctx.fillRect(~~x, ~~y, ~~Math.max(1, w), ~~Math.max(1, h));
        }
        function txt(s, x, y, font, c, align, maxW) {
          ctx.save();
          ctx.font = font; ctx.fillStyle = c;
          ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
          if (maxW) ctx.fillText(s, ~~x, ~~y, maxW);
          else      ctx.fillText(s, ~~x, ~~y);
          ctx.restore();
        }
        function measure(s, font) {
          ctx.save(); ctx.font = font;
          const w = ctx.measureText(s).width;
          ctx.restore(); return w;
        }
        function trunc(s, maxPx, font) {
          if (measure(s, font) <= maxPx) return s;
          while (s.length > 1 && measure(s + '…', font) > maxPx) s = s.slice(0, -1);
          return s + '…';
        }

        // ── 2. Background ────────────────────────────────────────────────────
        box(0, 0, W, H, C_BG);

        // ── 3. Image — cover-fit so it fills the entire canvas with no gaps ──
        // Minor crop on one axis is acceptable so there's zero dark letterboxing.
        // The gradient overlay will obscure the very bottom ~40%, so any tiny crop
        // there is invisible to the viewer.
        if (imgEl) {
          const scale = Math.max(W / imgEl.naturalWidth, H / imgEl.naturalHeight);
          const dw = imgEl.naturalWidth  * scale;
          const dh = imgEl.naturalHeight * scale;
          // Center the image both axes so the mid-section is always visible
          ctx.drawImage(imgEl, (W - dw) / 2, (H - dh) / 2, dw, dh);
        } else {
          // Placeholder for items without an image
          box(0, 0, W, H, '#12121a');
          ctx.save();
          ctx.font = '72px system-ui,sans-serif';
          ctx.fillStyle = '#232330';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('◈', W / 2, H * 0.38);
          ctx.restore();
        }

        // ── 4. Gradient overlay — bottom ~55% of the canvas ─────────────────
        // Starts transparent, densifies towards the bottom so the image colour
        // bleeds naturally into the text area.
        const gradTop  = H * 0.30;  // gradient begins 30% from top
        const grad = ctx.createLinearGradient(0, gradTop, 0, H);
        grad.addColorStop(0,    'rgba(0,0,0,0)');
        grad.addColorStop(0.22, 'rgba(6,6,12,0.35)');
        grad.addColorStop(0.52, 'rgba(6,6,12,0.78)');
        grad.addColorStop(0.78, 'rgba(6,6,12,0.93)');
        grad.addColorStop(1,    'rgba(6,6,12,0.98)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, gradTop, W, H - gradTop);

        // ── 5. Compute text block starting position ──────────────────────────
        // Bottom-anchored: work from footer upwards so nothing ever clips.
        const FOOTER_Y   = H - 10;
        const STAT_END_Y = FOOTER_Y - 16;
        const STAT_START = STAT_END_Y - N * STAT_ROW_H;
        const DIV_Y      = STAT_START - 10;
        const SCORE_Y    = DIV_Y - 12;
        const NAME_Y     = SCORE_Y - 26;

        // ── 6. Item name ─────────────────────────────────────────────────────
        const nameSize   = NAME_Y > H * 0.48 ? 28 : 24; // shrink if tight
        const nameFont   = `800 ${nameSize}px system-ui,-apple-system,Arial,sans-serif`;
        const nameMaxW   = W - PAD * 2 - 80; // leave room for score badge
        txt(trunc(item.name, nameMaxW, nameFont), PAD, NAME_Y, nameFont, C_WHITE);

        // ── 7. Overall score — sits on the name baseline, right-aligned ──────
        const score     = overallScore(item).toFixed(1);
        const scoreStr  = `${score}/${statMax}`;
        const scoreFont = '700 13px system-ui,Arial,sans-serif';
        txt(scoreStr, W - PAD, NAME_Y, scoreFont, C_ACCENT, 'right');

        // ── 8. Thin divider ───────────────────────────────────────────────────
        box(PAD, DIV_Y, W - PAD * 2, 1, C_DIV);

        // ── 9. Stat rows — label · bar · value ───────────────────────────────
        const barW      = W - PAD * 2;
        const BAR_H     = STAT_ROW_H > 28 ? 4 : 3;
        const labelFont = `600 ${STAT_ROW_H > 28 ? 11 : 10}px system-ui,Arial,sans-serif`;
        const valFont   = `700 ${STAT_ROW_H > 28 ? 12 : 11}px system-ui,Arial,sans-serif`;

        visStats.forEach((k, i) => {
          const v   = item.stats?.[k] ?? 0;
          const pct = statMax > 0 ? Math.min(v / statMax, 1) : 0;
          const ry  = STAT_START + i * STAT_ROW_H;

          // Label
          const label   = trunc(k.toUpperCase(), barW - 40, labelFont);
          const textBaseline = ry + STAT_ROW_H * 0.45;
          txt(label, PAD, textBaseline, labelFont, C_LABEL, 'left');

          // Value
          txt(String(v), W - PAD, textBaseline, valFont, C_WHITE, 'right');

          // Bar — sits below the text, tight spacing
          const barY = ry + STAT_ROW_H * 0.68;
          box(PAD, barY, barW, BAR_H, C_TRACK);
          if (pct > 0) {
            box(PAD, barY, Math.max(barW * pct, BAR_H * 2), BAR_H, C_ACCENT);
          }
        });

        // ── 10. Footer watermark ─────────────────────────────────────────────
        txt('Made with ◈ Axis', W - PAD, FOOTER_Y,
            '500 10px system-ui,Arial,sans-serif', C_DIM, 'right');

        // ── 11. Top-left corner mark ──────────────────────────────────────────
        txt('◈ AXIS', PAD, 18,
            '600 9px system-ui,Arial,sans-serif', C_DIM, 'left');

        // ── 12. Download ─────────────────────────────────────────────────────
        const a = document.createElement('a');
        a.download = `${item.name.replace(/[^a-z0-9]/gi, '_')}.png`;
        a.href = canvas.toDataURL('image/png');
        a.click();
        showToast('Image saved.');
      }

      // Load primary image then build
      const src = axisImgSrc(item.img);
      if (src) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => build(img);
        img.onerror = () => build(null);
        img.src = src;
      } else {
        build(null);
      }
    }

    // ── SHARE LEADERBOARD AS IMAGE ──────────────────────
    // Same visual language as shareItemAsImage above (fixed dark palette,
    // same font stack, self-contained draw helpers) — but renders the
    // whole ranking instead of one item. Two formats share one loader/
    // download pipeline: 'list' (rows) and 'grid' (cards).
    function shareLeaderboardAsImage(format) {
      if (!items.length) { showToast('No items to include in the leaderboard yet.', true); return; }
      if (!categories.length) { showToast('Add a category first — ranking needs at least one.', true); return; }

      const MAX_ITEMS = 20; // keeps the image a sane size; overflow is noted at the bottom
      const sorted    = [...items].sort((a, b) => overallScore(b) - overallScore(a));
      const shown     = sorted.slice(0, MAX_ITEMS);
      const overflow  = sorted.length - shown.length;

      // Preload every visible item's primary thumbnail (or null if it has
      // none / fails to load) before drawing anything
      const loaders = shown.map(item => new Promise(resolve => {
        const src = axisImgSrc(item.img);
        if (!src) { resolve(null); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      }));

      Promise.all(loaders).then(thumbs => {
        const canvas = format === 'grid'
          ? buildLeaderboardGridImage(shown, sorted.length, overflow, thumbs)
          : buildLeaderboardListImage(shown, sorted.length, overflow, thumbs);

        const a = document.createElement('a');
        a.download = `axis_ranking_${format === 'grid' ? 'grid_' : ''}${new Date().toISOString().slice(0, 10)}.png`;
        a.href = canvas.toDataURL('image/png');
        a.click();
        showToast('Leaderboard image saved.');
      });
    }

    function buildLeaderboardListImage(shown, totalCount, overflow, thumbs) {
      const W        = 480;
      const PAD      = 22;
      const ROW_H    = 54;
      const HEADER_H = 78;
      const FOOTER_H = overflow > 0 ? 46 : 30;
      const H = HEADER_H + shown.length * ROW_H + FOOTER_H;

      // Fixed dark palette — always looks the same regardless of the app's
      // current theme, same as the single-item share image
      const C_BG     = '#09090d';
      const C_ROW    = '#131319'; // alternating row tint
      const C_ACCENT = '#d94f5c';
      const C_WHITE  = '#ffffff';
      const C_LABEL  = 'rgba(255,255,255,0.5)';
      const C_TRACK  = 'rgba(255,255,255,0.12)';
      const C_DIV    = 'rgba(255,255,255,0.1)';
      const C_DIM    = 'rgba(255,255,255,0.22)';
      const RANK_COLORS = ['#ffd700', '#c0c0c0', '#cd7f32']; // gold, silver, bronze

      const canvas = document.createElement('canvas');
      const DPR = Math.max(1, Math.round(window.devicePixelRatio || 1));
      canvas.width  = W * DPR;
      canvas.height = H * DPR;
      const ctx = canvas.getContext('2d');
      ctx.scale(DPR, DPR);

      function box(x, y, w, h, c) {
        ctx.fillStyle = c;
        ctx.fillRect(~~x, ~~y, ~~Math.max(1, w), ~~Math.max(1, h));
      }
      function roundBox(x, y, w, h, r, c) {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
        ctx.fill();
      }
      function txt(s, x, y, font, c, align) {
        ctx.save();
        ctx.font = font; ctx.fillStyle = c;
        ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(s, ~~x, ~~y);
        ctx.restore();
      }
      function measure(s, font) {
        ctx.save(); ctx.font = font;
        const w = ctx.measureText(s).width;
        ctx.restore(); return w;
      }
      function trunc(s, maxPx, font) {
        if (measure(s, font) <= maxPx) return s;
        while (s.length > 1 && measure(s + '…', font) > maxPx) s = s.slice(0, -1);
        return s + '…';
      }

      // ── Background ──────────────────────────────────────────────────
      box(0, 0, W, H, C_BG);

      // ── Header ───────────────────────────────────────────────────────
      txt('🏆 Axis Ranking', PAD, 34, '800 22px system-ui,-apple-system,Arial,sans-serif', C_WHITE, 'left');
      const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      txt(`${totalCount} item${totalCount === 1 ? '' : 's'} · ${dateStr}`, W - PAD, 34,
          '600 12px system-ui,Arial,sans-serif', C_LABEL, 'right');
      box(PAD, 50, W - PAD * 2, 1, C_DIV);

      // ── Rows ─────────────────────────────────────────────────────────
      shown.forEach((item, i) => {
        const ry     = HEADER_H + i * ROW_H;
        const isTop3 = i < 3;
        const accent = isTop3 ? RANK_COLORS[i] : C_ACCENT;

        if (i % 2 === 1) box(0, ry, W, ROW_H, C_ROW);

        // Rank number
        const rankFont = isTop3 ? '900 20px system-ui,Arial,sans-serif' : '800 16px system-ui,Arial,sans-serif';
        txt(`#${i + 1}`, PAD, ry + ROW_H / 2 + 6, rankFont, isTop3 ? accent : C_LABEL, 'left');

        // Thumbnail — rounded square, cover-fit, placeholder mark if none
        const thumbSize = 38;
        const thumbX    = PAD + 44;
        const thumbY    = ry + (ROW_H - thumbSize) / 2;
        const img = thumbs[i];
        if (img) {
          ctx.save();
          const rr = 6;
          ctx.beginPath();
          ctx.moveTo(thumbX + rr, thumbY);
          ctx.arcTo(thumbX + thumbSize, thumbY, thumbX + thumbSize, thumbY + thumbSize, rr);
          ctx.arcTo(thumbX + thumbSize, thumbY + thumbSize, thumbX, thumbY + thumbSize, rr);
          ctx.arcTo(thumbX, thumbY + thumbSize, thumbX, thumbY, rr);
          ctx.arcTo(thumbX, thumbY, thumbX + thumbSize, thumbY, rr);
          ctx.closePath();
          ctx.clip();
          const scale = Math.max(thumbSize / img.naturalWidth, thumbSize / img.naturalHeight);
          const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
          ctx.drawImage(img, thumbX + (thumbSize - dw) / 2, thumbY + (thumbSize - dh) / 2, dw, dh);
          ctx.restore();
        } else {
          roundBox(thumbX, thumbY, thumbSize, thumbSize, 6, '#1c1c24');
          txt('◈', thumbX + thumbSize / 2, thumbY + thumbSize / 2 + 6, '18px system-ui,sans-serif', C_DIM, 'center');
        }

        // Name + mini score bar
        const nameX    = thumbX + thumbSize + 14;
        const scoreStr = overallScore(item).toFixed(1);
        const nameMaxW = W - PAD - nameX - measure(scoreStr, '800 16px system-ui,Arial,sans-serif') - 50;
        const nameFont = '700 15px system-ui,-apple-system,Arial,sans-serif';
        txt(trunc(item.name, nameMaxW, nameFont), nameX, ry + ROW_H / 2 - 3, nameFont, C_WHITE, 'left');

        const barY = ry + ROW_H / 2 + 8;
        const pct  = statMax > 0 ? Math.min(overallScore(item) / statMax, 1) : 0;
        roundBox(nameX, barY, nameMaxW, 4, 2, C_TRACK);
        if (pct > 0) roundBox(nameX, barY, Math.max(nameMaxW * pct, 6), 4, 2, accent);

        // Score, right-aligned
        txt(scoreStr, W - PAD, ry + ROW_H / 2 + 4, '800 16px system-ui,Arial,sans-serif', accent, 'right');
      });

      // ── Footer ───────────────────────────────────────────────────────
      const footerTop = HEADER_H + shown.length * ROW_H;
      box(PAD, footerTop, W - PAD * 2, 1, C_DIV);
      if (overflow > 0) {
        txt(`+ ${overflow} more item${overflow === 1 ? '' : 's'} not shown`, PAD, footerTop + 20,
            '600 11px system-ui,Arial,sans-serif', C_LABEL, 'left');
      }
      txt('Made with ◈ Axis', W - PAD, H - 12, '500 10px system-ui,Arial,sans-serif', C_DIM, 'right');

      return canvas;
    }

    function buildLeaderboardGridImage(shown, totalCount, overflow, thumbs) {
      const COLS      = 3;
      const CARD_W    = 148;
      const CARD_H    = 176;
      const GAP       = 14;
      const PAD       = 22;
      const HEADER_H  = 78;
      const FOOTER_H  = overflow > 0 ? 46 : 30;

      const rows = Math.ceil(shown.length / COLS);
      const W    = PAD * 2 + COLS * CARD_W + (COLS - 1) * GAP;
      const H    = HEADER_H + rows * CARD_H + (rows - 1) * GAP + FOOTER_H;

      // Same fixed dark palette as the list format, so both formats look
      // like they belong to the same product regardless of app theme
      const C_BG     = '#09090d';
      const C_CARD   = '#131319';
      const C_ACCENT = '#d94f5c';
      const C_WHITE  = '#ffffff';
      const C_LABEL  = 'rgba(255,255,255,0.5)';
      const C_TRACK  = 'rgba(255,255,255,0.12)';
      const C_DIV    = 'rgba(255,255,255,0.1)';
      const C_DIM    = 'rgba(255,255,255,0.22)';
      const RANK_COLORS = ['#ffd700', '#c0c0c0', '#cd7f32']; // gold, silver, bronze

      const canvas = document.createElement('canvas');
      const DPR = Math.max(1, Math.round(window.devicePixelRatio || 1));
      canvas.width  = W * DPR;
      canvas.height = H * DPR;
      const ctx = canvas.getContext('2d');
      ctx.scale(DPR, DPR);

      function box(x, y, w, h, c) {
        ctx.fillStyle = c;
        ctx.fillRect(~~x, ~~y, ~~Math.max(1, w), ~~Math.max(1, h));
      }
      function roundBox(x, y, w, h, r, c) {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
        ctx.fill();
      }
      function txt(s, x, y, font, c, align) {
        ctx.save();
        ctx.font = font; ctx.fillStyle = c;
        ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(s, ~~x, ~~y);
        ctx.restore();
      }
      function measure(s, font) {
        ctx.save(); ctx.font = font;
        const w = ctx.measureText(s).width;
        ctx.restore(); return w;
      }
      function trunc(s, maxPx, font) {
        if (measure(s, font) <= maxPx) return s;
        while (s.length > 1 && measure(s + '…', font) > maxPx) s = s.slice(0, -1);
        return s + '…';
      }

      // ── Background ──────────────────────────────────────────────────
      box(0, 0, W, H, C_BG);

      // ── Header ───────────────────────────────────────────────────────
      txt('🏆 Axis Ranking', PAD, 34, '800 22px system-ui,-apple-system,Arial,sans-serif', C_WHITE, 'left');
      const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      txt(`${totalCount} item${totalCount === 1 ? '' : 's'} · ${dateStr}`, W - PAD, 34,
          '600 12px system-ui,Arial,sans-serif', C_LABEL, 'right');
      box(PAD, 50, W - PAD * 2, 1, C_DIV);

      // ── Cards ────────────────────────────────────────────────────────
      const thumbSize = CARD_W - 24; // square thumbnail, inset within the card
      shown.forEach((item, i) => {
        const col  = i % COLS;
        const row  = Math.floor(i / COLS);
        const cx   = PAD + col * (CARD_W + GAP);
        const cy   = HEADER_H + row * (CARD_H + GAP);
        const isTop3 = i < 3;
        const accent = isTop3 ? RANK_COLORS[i] : C_ACCENT;

        roundBox(cx, cy, CARD_W, CARD_H, 8, C_CARD);
        if (isTop3) {
          // subtle top accent edge for medal ranks
          roundBox(cx, cy, CARD_W, 3, 2, accent);
        }

        // Thumbnail
        const thumbX = cx + 12;
        const thumbY = cy + 12;
        const img = thumbs[i];
        if (img) {
          ctx.save();
          const rr = 6;
          ctx.beginPath();
          ctx.moveTo(thumbX + rr, thumbY);
          ctx.arcTo(thumbX + thumbSize, thumbY, thumbX + thumbSize, thumbY + thumbSize, rr);
          ctx.arcTo(thumbX + thumbSize, thumbY + thumbSize, thumbX, thumbY + thumbSize, rr);
          ctx.arcTo(thumbX, thumbY + thumbSize, thumbX, thumbY, rr);
          ctx.arcTo(thumbX, thumbY, thumbX + thumbSize, thumbY, rr);
          ctx.closePath();
          ctx.clip();
          const scale = Math.max(thumbSize / img.naturalWidth, thumbSize / img.naturalHeight);
          const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
          ctx.drawImage(img, thumbX + (thumbSize - dw) / 2, thumbY + (thumbSize - dh) / 2, dw, dh);
          ctx.restore();
        } else {
          roundBox(thumbX, thumbY, thumbSize, thumbSize, 6, '#1c1c24');
          txt('◈', thumbX + thumbSize / 2, thumbY + thumbSize / 2 + 8, '26px system-ui,sans-serif', C_DIM, 'center');
        }

        // Rank badge, top-left corner of the thumbnail
        const badgeR = 13;
        const badgeCx = thumbX + badgeR - 2;
        const badgeCy = thumbY + badgeR - 2;
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = isTop3 ? accent : 'rgba(9,9,13,0.85)';
        ctx.fill();
        const rankFont = isTop3 ? '900 12px system-ui,Arial,sans-serif' : '800 11px system-ui,Arial,sans-serif';
        txt(`${i + 1}`, badgeCx, badgeCy + 4, rankFont, isTop3 ? '#09090d' : C_WHITE, 'center');

        // Name
        const textY1 = thumbY + thumbSize + 20;
        const nameFont = '700 13px system-ui,-apple-system,Arial,sans-serif';
        txt(trunc(item.name, CARD_W - 24, nameFont), cx + 12, textY1, nameFont, C_WHITE, 'left');

        // Score bar
        const barY = textY1 + 10;
        const barW = CARD_W - 24;
        const pct  = statMax > 0 ? Math.min(overallScore(item) / statMax, 1) : 0;
        roundBox(cx + 12, barY, barW, 4, 2, C_TRACK);
        if (pct > 0) roundBox(cx + 12, barY, Math.max(barW * pct, 6), 4, 2, accent);

        // Score number
        const scoreStr = overallScore(item).toFixed(1);
        txt(scoreStr, cx + CARD_W - 12, barY + 20, '800 14px system-ui,Arial,sans-serif', accent, 'right');
      });

      // ── Footer ───────────────────────────────────────────────────────
      const footerTop = HEADER_H + rows * CARD_H + (rows - 1) * GAP;
      box(PAD, footerTop, W - PAD * 2, 1, C_DIV);
      if (overflow > 0) {
        txt(`+ ${overflow} more item${overflow === 1 ? '' : 's'} not shown`, PAD, footerTop + 20,
            '600 11px system-ui,Arial,sans-serif', C_LABEL, 'left');
      }
      txt('Made with ◈ Axis', W - PAD, H - 12, '500 10px system-ui,Arial,sans-serif', C_DIM, 'right');

      return canvas;
    }

    // ── STATIC HTML EXPORT ───────────────────────────────
    // Generates one fully self-contained .html file — inline CSS, base64
    // images, zero external requests, zero runtime JavaScript. Opens
    // identically in any browser, anywhere, forever, with no dependency on
    // Axis itself. Everything (chart bars included) is computed once here
    // and baked into fixed inline styles, matching shareItemAsImage's
    // "always the same fixed dark palette" philosophy so a shared page
    // looks consistent regardless of the sender's or viewer's app theme.
    function exportStaticHTML() {
      if (!items.length) { showToast('No items to export yet.', true); return; }
      if (!categories.length) { showToast('Add a category first — a ranking needs at least one.', true); return; }

      const sorted = [...items].sort((a, b) => overallScore(b) - overallScore(a));
      const RANK_COLORS = ['#ffd700', '#c0c0c0', '#cd7f32'];

      // ── Category averages — purely descriptive, computed once ──────────
      const catAverages = categories.map(cat => {
        const vals = items.map(it => it.stats?.[cat] ?? 0);
        const avg  = vals.reduce((a, b) => a + b, 0) / vals.length;
        return { cat, avg };
      });

      const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

      // ── Category averages chart — plain HTML/CSS bars, no runtime JS ───
      const avgChartHtml = catAverages.map(({ cat, avg }) => {
        const pct = statMax > 0 ? Math.min(avg / statMax, 1) * 100 : 0;
        return `
        <div class="avg-row">
          <div class="avg-label">${esc(cat)}</div>
          <div class="avg-track"><div class="avg-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="avg-val">${avg.toFixed(1)}</div>
        </div>`;
      }).join('');

      // ── Ranked item rows ─────────────────────────────────────────────
      const rowsHtml = sorted.map((item, i) => {
        const isTop3   = i < 3;
        const rankCol  = isTop3 ? RANK_COLORS[i] : 'var(--muted)';
        const score    = overallScore(item);
        const src      = axisImgSrc(item.img);
        const thumbHtml = src
          ? `<img class="item-thumb" src="${src}" alt="">`
          : `<div class="item-thumb item-thumb-ph">◈</div>`;

        const tagsHtml = (item.tags || []).length
          ? `<div class="item-tags">${item.tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('')}</div>`
          : '';

        const bioHtml = item.bio
          ? `<div class="item-bio">${esc(item.bio)}</div>`
          : '';

        const statsHtml = categories.map(cat => {
          const v   = item.stats?.[cat] ?? 0;
          const pct = statMax > 0 ? Math.min(v / statMax, 1) * 100 : 0;
          return `
            <div class="stat-row">
              <div class="stat-label">${esc(cat)}</div>
              <div class="stat-track"><div class="stat-fill" style="width:${pct.toFixed(1)}%"></div></div>
              <div class="stat-val">${v}</div>
            </div>`;
        }).join('');

        return `
        <div class="item-card">
          <div class="item-card-head">
            <div class="rank-num" style="color:${rankCol}">#${i + 1}</div>
            ${thumbHtml}
            <div class="item-card-title">
              <div class="item-name">${esc(item.name)}</div>
              ${tagsHtml}
            </div>
            <div class="item-score" style="color:${isTop3 ? rankCol : 'var(--accent)'}">${score.toFixed(1)}<span>/${statMax}</span></div>
          </div>
          ${bioHtml}
          <div class="item-stats">${statsHtml}</div>
        </div>`;
      }).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Axis Ranking — ${esc(sorted.length)} items</title>
<style>
  :root {
    --bg: #0d0d0f; --surface: #16161a; --border: #2a2a32;
    --accent: #d94f5c; --accent2: #4ae8c9;
    --text: #e8e8ec; --muted: #6b6b7a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
    padding: 32px 20px 60px;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 36px; }
  header h1 {
    font-size: 1.9rem; font-weight: 800; letter-spacing: -.01em;
    background: linear-gradient(110deg, var(--accent) 0%, #f2f2f2 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  header p { color: var(--muted); font-size: .85rem; margin-top: 6px; }

  section { margin-bottom: 32px; }
  .section-title {
    font-size: .72rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
  }

  .avg-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .avg-label { width: 120px; flex-shrink: 0; font-size: .82rem; font-weight: 600; }
  .avg-track { flex: 1; height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; }
  .avg-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); }
  .avg-val { width: 34px; text-align: right; font-size: .8rem; font-weight: 700; color: var(--accent2); flex-shrink: 0; }

  .item-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 16px; margin-bottom: 10px;
  }
  .item-card-head { display: flex; align-items: center; gap: 12px; }
  .rank-num { font-weight: 900; font-size: 1.1rem; width: 32px; flex-shrink: 0; }
  .item-thumb {
    width: 44px; height: 44px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: var(--bg);
  }
  .item-thumb-ph { display: flex; align-items: center; justify-content: center; color: var(--border); font-size: 1.2rem; }
  .item-card-title { flex: 1; min-width: 0; }
  .item-name { font-weight: 700; font-size: 1rem; }
  .item-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .tag-chip {
    font-size: .66rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
    color: var(--accent); background: rgba(217,79,92,.12); border: 1px solid rgba(217,79,92,.25);
    padding: 1px 6px; border-radius: 3px;
  }
  .item-score { font-weight: 800; font-size: 1.2rem; flex-shrink: 0; }
  .item-score span { font-size: .7rem; font-weight: 500; opacity: .6; }
  .item-bio {
    font-size: .82rem; color: var(--muted); line-height: 1.5; margin: 10px 0 4px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .item-stats { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .stat-row { display: flex; align-items: center; gap: 10px; }
  .stat-label { width: 110px; flex-shrink: 0; font-size: .72rem; color: var(--muted); }
  .stat-track { flex: 1; height: 5px; border-radius: 3px; background: var(--bg); overflow: hidden; }
  .stat-fill { height: 100%; background: var(--accent); }
  .stat-val { width: 30px; text-align: right; font-size: .74rem; font-weight: 700; flex-shrink: 0; }

  footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); }
  footer p { font-size: .74rem; color: var(--muted); letter-spacing: .02em; }
  footer a { color: var(--accent2); text-decoration: none; border-bottom: 1px solid rgba(74,232,201,.3); }

  @media (max-width: 480px) {
    .item-card-head { flex-wrap: wrap; }
    .stat-label { width: 84px; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>◈ Axis Ranking</h1>
      <p>${esc(sorted.length)} item${sorted.length === 1 ? '' : 's'} · ${esc(dateStr)}</p>
    </header>

    <section>
      <div class="section-title">Category Averages</div>
      ${avgChartHtml}
    </section>

    <section>
      <div class="section-title">Ranking</div>
      ${rowsHtml}
    </section>

    <footer>
      <p>Made with ◈ <a href="https://github.com/PR0Gorib/Axis/" target="_blank" rel="noopener noreferrer">Axis</a> — a general purpose comparison &amp; ranking tool</p>
    </footer>
  </div>
</body>
</html>`;

      dl(new Blob([html], { type: 'text/html' }), `axis_ranking_${new Date().toISOString().slice(0, 10)}.html`);
      showToast('Shareable page saved.');
    }

    // ── KEYBOARD ──────────────────────────────────────
    // True while focus is in a text field / textarea / contenteditable —
    // shortcuts below must not fire while the person is just typing.
    function _isTypingContext() {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    }

    // True while any modal, viewer, or the hamburger drawer is open —
    // shortcuts below are scoped to the base grid/panel view only.
    function _anyOverlayOpen() {
      const ids = [
        'modal-overlay', 'cat-modal-overlay', 'backup-modal-overlay',
        'settings-modal-overlay', 'projects-modal-overlay', 'cmp-overlay',
        'bulk-overlay', 'viewer-overlay', 'ham-drawer', 'radar-zoom-overlay',
        'switcher-overlay',
      ];
      return ids.some(id => document.getElementById(id)?.classList.contains('open'));
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (document.getElementById('radar-zoom-overlay')?.classList.contains('open')) {
          closeRadarZoom();
          return;
        }
        if (document.getElementById('switcher-overlay')?.classList.contains('open')) {
          closeProjectSwitcher();
          return;
        }
        closeModal(); closePanel(); closeCatModal(); closeCompare(); closeBackupModal();
        closeSettingsModal(); closeProjectsModal(); closeViewer();
        if (bulkEditMode) exitBulkEditMode();
      }
      // Ctrl/Cmd+K opens the project quick switcher. Skipped while typing in
      // a field (don't yank focus away mid-sentence) or while some other
      // modal is already open (stacking the switcher on top would look
      // broken) — but pressing it again while the switcher itself is open
      // closes it, and it's allowed through the general overlay gate below
      // for exactly that toggle-closed case.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        const switcherOpen = document.getElementById('switcher-overlay')?.classList.contains('open');
        if (switcherOpen) {
          e.preventDefault();
          closeProjectSwitcher();
          return;
        }
        if (!_isTypingContext() && !_anyOverlayOpen()) {
          e.preventDefault();
          openProjectSwitcher();
          return;
        }
      }
      // Ctrl/Cmd+F focuses search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        const s = document.getElementById('search-input');
        if (document.activeElement !== s) { e.preventDefault(); s.focus(); s.select(); }
      }

      // Arrow-key image navigation — works in the side panel AND the
      // fullscreen viewer, since the viewer always mirrors whichever
      // carousel image is currently active. Deliberately placed before the
      // general overlay gate below, since the viewer being open is one of
      // the overlays that gate would otherwise block this on.
      if (!_isTypingContext() && !e.ctrlKey && !e.metaKey && !e.altKey &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const viewerOpen = document.getElementById('viewer-overlay').classList.contains('open');
        const panelOpenForNav = document.getElementById('panel').classList.contains('open');
        if ((viewerOpen || panelOpenForNav) && _panelImgs.length > 1) {
          e.preventDefault();
          panelImgNav(e.key === 'ArrowLeft' ? -1 : 1);
        }
      }

      // Power-user shortcuts — skip while typing, while bulk editing, or
      // while any modal/overlay is open
      if (_isTypingContext() || _anyOverlayOpen() || bulkEditMode) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const panelOpen = document.getElementById('panel').classList.contains('open');

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openAddModal();
      } else if ((e.key === 'e' || e.key === 'E') && panelOpen) {
        e.preventDefault();
        document.getElementById('panel-edit-btn').click();
      } else if (e.key === 'Delete' && panelOpen) {
        e.preventDefault();
        document.getElementById('panel-del-btn').click();
      }
    });

    // ── INIT ──────────────────────────────────────────
    (async () => {
      loadTemplates();

      // Shortcut hints default to the Mac symbol in markup; correct to
      // "Ctrl" text on other platforms
      if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) {
        document.querySelectorAll('.ham-shortcut-hint').forEach(el => {
          el.textContent = el.textContent.replace('⌘', 'Ctrl+');
        });
      }

      // Everything below touches storage, settings, and platform-specific
      // APIs — none of it has been exercised on every target this app now
      // runs on (Android in particular). A single unexpected throw here
      // used to leave a permanently blank screen with no way to even see
      // the app shell, since nothing after the failure point ever ran.
      // Guard the whole sequence so a failure anywhere still gets you to
      // a rendered (if possibly empty/default) app, rather than nothing.
      try {
        // Init Tauri storage directories
        await axisInit();

        // Restore settings (Tauri file or localStorage fallback)
        const settings = await axisLoadSettings();
        if (settings.theme === 'light') {
          lightMode = true;
          document.body.classList.add('light');
          const btn = document.getElementById('theme-toggle-btn');
          const emoji = btn?.querySelector('.tt-emoji');
          const label = document.getElementById('tt-label');
          if (emoji) emoji.innerHTML = Icons.sun;
          if (label) label.textContent = 'Light';
          if (btn) btn.title = 'Switch to dark mode';
        }
        // statMax used to be a single global setting (settings.json). It's
        // now per-project, stored in each project's data.json alongside
        // items/categories. We don't yet know which value to use here — that
        // depends on THIS project's data.json, loaded just below — so hold
        // settings.statMax aside as the legacy fallback for projects that
        // predate the per-project change, rather than applying it directly.
        const legacyStatMax = settings.statMax === 100 ? 100 : 10;
        if (settings.viewMode === 'list') {
          viewMode = 'list';
        }

        // Load data
        const loaded = await axisLoad();
        items = loaded.items;
        categories = loaded.categories;
        // This project's own statMax if it has one; otherwise inherit the
        // old global value once so existing projects don't silently reset
        // to the 0-10 default. New projects with no legacy setting either
        // just get the app default (10) from statMax's initial declaration.
        statMax = loaded.statMax ?? legacyStatMax;
        const statBtn = document.getElementById('stat-max-btn');
        if (statBtn) statBtn.textContent = `Max Stat: ${statMax}`;
        // Always sync score filter ceiling to statMax so nothing is hidden on load
        scoreFilterMax = statMax;
        updateScoreFilterInputs();

        // Which project is this? (name shown in header, used for export filenames)
        await axisRefreshActiveProject();
      } catch (e) {
        console.error('[Axis] init failed, continuing with whatever state was loaded so far:', e);
      }

      render();

      // Silent update check — only surfaces the banner if a newer release
      // exists. Already self-contained (own try/catch), and deliberately
      // outside the block above so a network hiccup here can never affect
      // whether the app itself finishes loading.
      checkForUpdates(false);
    })();


