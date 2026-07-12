import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp, where, setDoc, deleteDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyClLt8MbGabRC1L3pAshCnlUWdGL5ji4-Q",
  authDomain: "notes-2326b.firebaseapp.com",
  projectId: "notes-2326b",
  storageBucket: "notes-2326b.firebasestorage.app",
  messagingSenderId: "559883658305",
  appId: "1:559883658305:web:76a80fa6dad785e9a512c0",
  measurementId: "G-M9L0DXY6QW"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const MAX_FILE_BYTES = 700 * 1024; // ~700KB — keeps the note doc safely under Firestore's 1MB limit

(function(){
  let notes = [];
  let myVotes = {};          // { noteId: 'like' | 'dislike' }
  let myFollowing = {};      // { uploaderId: true }
  let currentUser = null;
  let unsubMyVotes = null;
  let unsubMyFollowing = null;
  let activeCategory = 'notes'; // 'notes' | 'question-paper'
  let currentProfileTarget = null; // { uploaderId, uploaderName }

  const stack = document.getElementById('notesStack');
  const resultsCount = document.getElementById('resultsCount');
  const statTotal = document.getElementById('statTotal');
  const statVotes = document.getElementById('statVotes');
  const filterCourse = document.getElementById('filterCourse');
  const filterYear = document.getElementById('filterYear');
  const filterSubject = document.getElementById('filterSubject');
  const searchBox = document.getElementById('searchBox');
  const followingOnlyToggle = document.getElementById('followingOnlyToggle');
  const sectionTabs = document.getElementById('sectionTabs');
  const fFile = document.getElementById('fFile');
  const fileNote = document.getElementById('fileNote');
  const fUploader = document.getElementById('fUploader');
  const fCategory = document.getElementById('fCategory');
  const uploadBtn = document.getElementById('uploadBtn');
  const signinGate = document.getElementById('signinGate');
  const authWidget = document.getElementById('authWidget');

  const authModal = document.getElementById('authModal');
  const loginPane = document.getElementById('loginPane');
  const registerPane = document.getElementById('registerPane');
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const loginError = document.getElementById('loginError');
  const registerError = document.getElementById('registerError');

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, s => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[s]));
  }
  function netScore(n){ return (n.likes||0) - (n.dislikes||0); }
  function isPdf(n){
    return !!(n.fileName && n.fileName.toLowerCase().endsWith('.pdf')) ||
           !!(n.fileDataUrl && n.fileDataUrl.startsWith('data:application/pdf'));
  }

  // ---------- Section tabs (Study Notes vs Question Papers) ----------
  sectionTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.section-tab');
    if (!btn) return;
    activeCategory = btn.dataset.category;
    [...sectionTabs.querySelectorAll('.section-tab')].forEach(b => b.classList.toggle('active', b === btn));
    fCategory.value = activeCategory; // new uploads default to whichever section you're browsing
    filterCourse.value = ''; filterYear.value = ''; filterSubject.value = ''; searchBox.value = '';
    refreshFilterOptions();
    render();
  });

  // ---------- Auth modal controls ----------
  function openModal(tab){
    authModal.classList.remove('hidden');
    loginError.textContent = '';
    registerError.textContent = '';
    setTab(tab || 'login');
  }
  function closeModal(){ authModal.classList.add('hidden'); }
  function setTab(tab){
    const isLogin = tab === 'login';
    tabLogin.classList.toggle('active', isLogin);
    tabRegister.classList.toggle('active', !isLogin);
    loginPane.classList.toggle('hidden', !isLogin);
    registerPane.classList.toggle('hidden', isLogin);
  }
  document.getElementById('openLoginBtn').addEventListener('click', () => openModal('login'));
  document.getElementById('openRegisterBtn').addEventListener('click', () => openModal('register'));
  document.getElementById('gateSignInBtn').addEventListener('click', () => openModal('login'));
  document.getElementById('closeModalBtn').addEventListener('click', closeModal);
  authModal.addEventListener('click', (e) => { if (e.target === authModal) closeModal(); });
  tabLogin.addEventListener('click', () => setTab('login'));
  tabRegister.addEventListener('click', () => setTab('register'));

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    try {
      await signInWithEmailAndPassword(
        auth,
        document.getElementById('loginEmail').value.trim(),
        document.getElementById('loginPassword').value
      );
      closeModal();
      e.target.reset();
    } catch (err) {
      loginError.textContent = friendlyAuthError(err);
    }
  });

  document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    registerError.textContent = '';
    try {
      const name = document.getElementById('regName').value.trim();
      const cred = await createUserWithEmailAndPassword(
        auth,
        document.getElementById('regEmail').value.trim(),
        document.getElementById('regPassword').value
      );
      await updateProfile(cred.user, { displayName: name });
      closeModal();
      e.target.reset();
    } catch (err) {
      registerError.textContent = friendlyAuthError(err);
    }
  });

  function friendlyAuthError(err){
    const code = err && err.code || '';
    if (code.includes('email-already-in-use')) return 'That email already has an account — try signing in.';
    if (code.includes('invalid-email')) return 'That email address looks invalid.';
    if (code.includes('weak-password')) return 'Password should be at least 6 characters.';
    if (code.includes('user-not-found') || code.includes('wrong-password') || code.includes('invalid-credential')) return 'Email or password is incorrect.';
    return 'Something went wrong. Please try again.';
  }

  // ---------- Leaderboard & Profile modals ----------
  const leaderboardModal = document.getElementById('leaderboardModal');
  const profileModal = document.getElementById('profileModal');

  document.getElementById('leaderboardBtn').addEventListener('click', () => {
    renderLeaderboard();
    leaderboardModal.classList.remove('hidden');
  });
  document.getElementById('closeLeaderboardBtn').addEventListener('click', () => leaderboardModal.classList.add('hidden'));
  leaderboardModal.addEventListener('click', (e) => { if (e.target === leaderboardModal) leaderboardModal.classList.add('hidden'); });

  document.getElementById('closeProfileBtn').addEventListener('click', () => profileModal.classList.add('hidden'));
  profileModal.addEventListener('click', (e) => { if (e.target === profileModal) profileModal.classList.add('hidden'); });

  const previewModal = document.getElementById('previewModal');
  document.getElementById('closePreviewBtn').addEventListener('click', () => previewModal.classList.add('hidden'));
  previewModal.addEventListener('click', (e) => { if (e.target === previewModal) previewModal.classList.add('hidden'); });

  async function openPdfPreview(note){
    const body = document.getElementById('previewBody');
    document.getElementById('previewTitle').textContent = note.title || 'Preview';

    const dlLink = document.getElementById('previewDownloadLink');
    dlLink.href = note.fileDataUrl;
    dlLink.download = note.fileName || 'note';

    body.innerHTML = '<p class="preview-status">Loading preview…</p>';
    previewModal.classList.remove('hidden');

    try {
      if (!window.pdfjsLib) throw new Error('preview engine unavailable');
      const base64 = note.fileDataUrl.split(',')[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      body.innerHTML = '';

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(560 / baseViewport.width, 2);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

        const pageWrap = document.createElement('div');
        pageWrap.className = 'preview-page';
        const label = document.createElement('div');
        label.className = 'preview-page-label';
        label.textContent = `Page ${pageNum} of ${pdf.numPages}`;
        pageWrap.appendChild(label);
        pageWrap.appendChild(canvas);
        body.appendChild(pageWrap);
      }
    } catch (err) {
      body.innerHTML = `<p class="preview-status">Could not generate a preview (${escapeHtml(err.message || 'unknown error')}). You can still download the file.</p>`;
    }
  }

  stack.addEventListener('click', (e) => {
    const pbtn = e.target.closest('.preview-trigger');
    if (!pbtn) return;
    const note = notes.find(n => n.id === pbtn.dataset.id);
    if (note) openPdfPreview(note);
  });

  // Any uploader-link button anywhere (note cards, leaderboard rows, "My Profile") opens a profile
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.uploader-link');
    if (!link) return;
    openProfile(link.dataset.uploaderId || null, link.dataset.uploaderName || 'Unknown');
  });

  function initials(name){
    return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  function computeContributors(){
    const map = {};
    notes.forEach(n => {
      const key = n.uploaderId || n.uploaderName || 'unknown';
      if (!map[key]) {
        map[key] = { uploaderId: n.uploaderId || null, uploaderName: n.uploaderName || 'Unknown', notesCount: 0, totalLikes: 0, totalDislikes: 0 };
      }
      map[key].notesCount++;
      map[key].totalLikes += (n.likes || 0);
      map[key].totalDislikes += (n.dislikes || 0);
    });
    return Object.values(map).sort((a, b) => b.totalLikes - a.totalLikes || b.notesCount - a.notesCount);
  }

  function renderLeaderboard(){
    const contributors = computeContributors();
    const list = document.getElementById('leaderboardList');
    if (!contributors.length){
      list.innerHTML = '<p class="form-note">No contributors yet — be the first to shelve a note.</p>';
      return;
    }
    list.innerHTML = contributors.slice(0, 10).map((c, i) => {
      const rank = i + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
      return `
      <div class="leaderboard-row">
        <span class="leaderboard-rank ${rank===1?'gold':''}">${medal}</span>
        <div>
          <button class="uploader-link leaderboard-name" data-uploader-id="${c.uploaderId||''}" data-uploader-name="${escapeHtml(c.uploaderName)}">${escapeHtml(c.uploaderName)}</button>
          <div class="leaderboard-sub">${c.notesCount} note${c.notesCount===1?'':'s'} shelved</div>
        </div>
        <span class="leaderboard-likes">▲ ${c.totalLikes}</span>
      </div>`;
    }).join('');
  }

  function openProfile(uploaderId, uploaderName){
    currentProfileTarget = { uploaderId, uploaderName };
    const theirNotes = notes
      .filter(n => uploaderId ? n.uploaderId === uploaderId : n.uploaderName === uploaderName)
      .sort((a, b) => netScore(b) - netScore(a));
    const totalLikes = theirNotes.reduce((s, n) => s + (n.likes || 0), 0);
    const totalDislikes = theirNotes.reduce((s, n) => s + (n.dislikes || 0), 0);

    document.getElementById('profileAvatar').textContent = initials(uploaderName);
    document.getElementById('profileName').textContent = uploaderName || 'Unknown contributor';
    document.getElementById('profileSub').textContent =
      (currentUser && uploaderId && currentUser.uid === uploaderId) ? 'This is you' : 'Community contributor';
    document.getElementById('profileNotesCount').textContent = theirNotes.length;
    document.getElementById('profileTotalLikes').textContent = totalLikes;
    document.getElementById('profileTotalDislikes').textContent = totalDislikes;

    const listEl = document.getElementById('profileNotesList');
    listEl.innerHTML = theirNotes.length
      ? theirNotes.map(n => `
        <div class="profile-note-row">
          <span class="pn-title">${escapeHtml(n.title || '')}${n.category==='question-paper' ? ' <span class="pill" style="font-size:.65rem;">Question Paper</span>' : ''}</span>
          <span class="pn-score">▲ ${n.likes||0} &nbsp; ▼ ${n.dislikes||0}</span>
        </div>`).join('')
      : '<p class="form-note">No notes uploaded yet.</p>';

    const followBtn = document.getElementById('profileFollowBtn');
    if (!uploaderId || !currentUser || currentUser.uid === uploaderId) {
      followBtn.classList.add('hidden');
    } else {
      followBtn.classList.remove('hidden');
      const isFollowing = !!myFollowing[uploaderId];
      followBtn.textContent = isFollowing ? '✓ Following' : '+ Follow';
      followBtn.classList.toggle('following', isFollowing);
    }

    const followersEl = document.getElementById('profileFollowers');
    followersEl.textContent = '…';
    if (uploaderId) {
      getDocs(query(collection(db, 'follows'), where('followedId', '==', uploaderId)))
        .then(snap => { followersEl.textContent = snap.size; })
        .catch(() => { followersEl.textContent = '—'; });
    } else {
      followersEl.textContent = '0';
    }

    profileModal.classList.remove('hidden');
  }

  document.getElementById('profileFollowBtn').addEventListener('click', async () => {
    if (!currentUser || !currentProfileTarget || !currentProfileTarget.uploaderId) return;
    const { uploaderId, uploaderName } = currentProfileTarget;
    const followRef = doc(db, 'follows', `${currentUser.uid}_${uploaderId}`);
    try {
      if (myFollowing[uploaderId]) {
        await deleteDoc(followRef);
      } else {
        await setDoc(followRef, {
          followerId: currentUser.uid,
          followedId: uploaderId,
          followedName: uploaderName,
          createdAt: serverTimestamp()
        });
      }
      openProfile(uploaderId, uploaderName); // refresh button state + follower count
    } catch (err) {
      alert('Could not update follow status: ' + err.message);
    }
  });

  // ---------- Auth state ----------
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user) {
      authWidget.innerHTML = `
        <button class="btn-ghost uploader-link" data-uploader-id="${user.uid}" data-uploader-name="${escapeHtml(user.displayName || user.email)}">👤 ${escapeHtml(user.displayName || user.email)}</button>
        <button class="btn-ghost" id="signOutBtn">Sign out</button>`;
      document.getElementById('signOutBtn').addEventListener('click', () => signOut(auth));

      fUploader.value = user.displayName || user.email;
      fUploader.disabled = true;
      uploadBtn.disabled = false;
      signinGate.classList.add('hidden');

      if (unsubMyVotes) unsubMyVotes();
      const votesQ = query(collection(db, 'votes'), where('userId', '==', user.uid));
      unsubMyVotes = onSnapshot(votesQ, (snap) => {
        myVotes = {};
        snap.forEach(d => { myVotes[d.data().noteId] = d.data().type; });
        render();
      });

      if (unsubMyFollowing) unsubMyFollowing();
      const followsQ = query(collection(db, 'follows'), where('followerId', '==', user.uid));
      unsubMyFollowing = onSnapshot(followsQ, (snap) => {
        myFollowing = {};
        snap.forEach(d => { myFollowing[d.data().followedId] = true; });
        render();
      });
      followingOnlyToggle.disabled = false;
    } else {
      authWidget.innerHTML = `
        <button class="btn-ghost" id="openLoginBtn">Sign in</button>
        <button class="btn-ghost" id="openRegisterBtn">Register</button>`;
      document.getElementById('openLoginBtn').addEventListener('click', () => openModal('login'));
      document.getElementById('openRegisterBtn').addEventListener('click', () => openModal('register'));

      fUploader.value = '';
      fUploader.disabled = true;
      uploadBtn.disabled = true;
      signinGate.classList.remove('hidden');

      if (unsubMyVotes) { unsubMyVotes(); unsubMyVotes = null; }
      if (unsubMyFollowing) { unsubMyFollowing(); unsubMyFollowing = null; }
      myVotes = {};
      myFollowing = {};
      followingOnlyToggle.disabled = true;
      followingOnlyToggle.checked = false;
      render();
    }
  });

  // ---------- Firestore: live notes ----------
  const notesQ = query(collection(db, 'notes'), orderBy('score', 'desc'));
  onSnapshot(notesQ, (snap) => {
    notes = [];
    snap.forEach(d => notes.push({ id: d.id, ...d.data() }));
    refreshFilterOptions();
    render();
  }, (err) => {
    resultsCount.textContent = 'Could not load notes: ' + err.message;
  });

  function refreshFilterOptions(){
    const inSection = notes.filter(n => (n.category || 'notes') === activeCategory);
    const courses = [...new Set(inSection.map(n => n.course))].sort();
    const subjects = [...new Set(inSection.map(n => n.subject))].sort();

    const currentCourse = filterCourse.value;
    filterCourse.innerHTML = '<option value="">All courses</option>' +
      courses.map(c => `<option ${c===currentCourse?'selected':''}>${escapeHtml(c)}</option>`).join('');

    const currentSubject = filterSubject.value;
    filterSubject.innerHTML = '<option value="">All subjects</option>' +
      subjects.map(s => `<option ${s===currentSubject?'selected':''}>${escapeHtml(s)}</option>`).join('');
  }

  function render(){
    const courseF = filterCourse.value;
    const yearF = filterYear.value;
    const subjectF = filterSubject.value;
    const searchF = searchBox.value.trim().toLowerCase();
    const followingOnly = followingOnlyToggle.checked && !followingOnlyToggle.disabled;

    let filtered = notes.filter(n => {
      const noteCategory = n.category || 'notes'; // older notes without a category default to Study Notes
      return noteCategory === activeCategory &&
        (!courseF || n.course === courseF) &&
        (!yearF || n.year === yearF) &&
        (!subjectF || n.subject === subjectF) &&
        (!searchF || (n.title || '').toLowerCase().includes(searchF)) &&
        (!followingOnly || myFollowing[n.uploaderId]);
    });

    const totalVotes = notes.reduce((sum, n) => sum + (n.likes||0) + (n.dislikes||0), 0);
    statTotal.textContent = notes.length;
    statVotes.textContent = totalVotes + (totalVotes === 1 ? ' total vote recorded' : ' total votes recorded');

    const noun = activeCategory === 'question-paper' ? 'question paper' : 'note';
    resultsCount.textContent = filtered.length
      ? `Showing ${filtered.length} ${noun}${filtered.length===1?'':'s'}, ranked by community score.`
      : `No ${noun}s match this search.`;

    if (!filtered.length){
      stack.innerHTML = `
        <div class="panel empty-state">
          <strong>The shelf is empty here.</strong>
          Try clearing a filter, or be the first to shelve a ${noun} for this combination.
        </div>`;
      return;
    }

    stack.innerHTML = filtered.map((n, i) => {
      const rank = i + 1;
      const isTop = rank === 1 && netScore(n) > 0;
      const myVote = myVotes[n.id] || null;
      const fileSection = n.fileDataUrl
        ? (isPdf(n)
            ? `<button type="button" class="link-btn preview-trigger" data-id="${n.id}">👁️ Preview document</button>`
            : `<span class="file-actions"><a href="${n.fileDataUrl}" download="${escapeHtml(n.fileName||'note')}">Download file</a></span>`)
        : (n.fileName ? escapeHtml(n.fileName) : 'No file attached');
      return `
      <article class="panel note-card ${isTop ? 'top-pick' : ''}" data-id="${n.id}">
        <span class="rank-badge">#${rank}</span>
        <div>
          <p class="note-meta">
            <span class="pill">${escapeHtml(n.course||'')}</span>
            <span class="pill">${escapeHtml(n.year||'')}</span>
            <span class="pill">${escapeHtml(n.subject||'')}</span>
          </p>
          <h3 class="note-title">${escapeHtml(n.title||'')}</h3>
          <p class="note-sub">${fileSection}</p>
          <p class="note-uploader">Uploaded by <button class="uploader-link" data-uploader-id="${n.uploaderId||''}" data-uploader-name="${escapeHtml(n.uploaderName||'Unknown')}">${escapeHtml(n.uploaderName||'Unknown')}</button></p>
        </div>
        <div class="vote-block">
          <button class="vote-btn like ${myVote==='like'?'active':''}" data-action="like" aria-pressed="${myVote==='like'}">▲ ${n.likes||0}</button>
          <button class="vote-btn dislike ${myVote==='dislike'?'active':''}" data-action="dislike" aria-pressed="${myVote==='dislike'}">▼ ${n.dislikes||0}</button>
          <span class="net-score">Score ${netScore(n) >= 0 ? '+' : ''}${netScore(n)}</span>
        </div>
      </article>`;
    }).join('');
  }

  // ---------- Voting (Firestore transaction) ----------
  stack.addEventListener('click', async (e) => {
    const btn = e.target.closest('.vote-btn');
    if (!btn) return;
    if (!currentUser) { openModal('login'); return; }

    const card = e.target.closest('.note-card');
    const noteId = card.dataset.id;
    const action = btn.dataset.action;
    btn.disabled = true;

    try {
      const voteRef = doc(db, 'votes', `${noteId}_${currentUser.uid}`);
      const noteRef = doc(db, 'notes', noteId);
      await runTransaction(db, async (tx) => {
        const voteSnap = await tx.get(voteRef);
        const noteSnap = await tx.get(noteRef);
        if (!noteSnap.exists()) return;
        let { likes = 0, dislikes = 0 } = noteSnap.data();
        const prev = voteSnap.exists() ? voteSnap.data().type : null;

        if (prev === action) {
          if (action === 'like') likes--; else dislikes--;
          tx.delete(voteRef);
        } else {
          if (prev === 'like') likes--;
          if (prev === 'dislike') dislikes--;
          if (action === 'like') likes++; else dislikes++;
          tx.set(voteRef, { noteId, userId: currentUser.uid, type: action, updatedAt: serverTimestamp() });
        }
        tx.update(noteRef, { likes, dislikes, score: likes - dislikes });
      });
    } catch (err) {
      alert('Could not record vote: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Upload ----------
  document.getElementById('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) { openModal('login'); return; }

    const title = document.getElementById('fTitle').value.trim();
    const course = document.getElementById('fCourse').value.trim();
    const year = document.getElementById('fYear').value;
    const subject = document.getElementById('fSubject').value.trim();
    if (!title || !course || !year || !subject) return;

    const file = fFile.files && fFile.files[0];
    if (file && file.size > MAX_FILE_BYTES) {
      fileNote.textContent = `That file is too large — please attach something under ${Math.round(MAX_FILE_BYTES/1024)}KB, or shelve the note without a file.`;
      fileNote.style.color = 'var(--stamp-red)';
      return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Shelving…';

    try {
      let fileName = null, fileDataUrl = null;
      if (file) {
        fileDataUrl = await readFileAsDataURL(file);
        fileName = file.name;
      }

      await addDoc(collection(db, 'notes'), {
        title, course, year, subject,
        category: fCategory.value,
        uploaderId: currentUser.uid,
        uploaderName: currentUser.displayName || currentUser.email,
        fileName, fileDataUrl,
        likes: 0, dislikes: 0, score: 0,
        createdAt: serverTimestamp()
      });

      e.target.reset();
      fUploader.value = currentUser.displayName || currentUser.email;
      fCategory.value = activeCategory;
      fileNote.textContent = 'No file attached — title and course info still get catalogued.';
    } catch (err) {
      alert('Could not upload note: ' + err.message);
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Shelve this note';
    }
  });

  fFile.addEventListener('change', () => {
    const file = fFile.files[0];
    if (!file) {
      fileNote.textContent = 'No file attached — title and course info still get catalogued.';
      fileNote.style.color = '';
      uploadBtn.disabled = !currentUser;
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      fileNote.textContent = `That file is ${Math.round(file.size/1024)}KB — please attach something under ${Math.round(MAX_FILE_BYTES/1024)}KB, or shelve the note without a file.`;
      fileNote.style.color = 'var(--stamp-red)';
      uploadBtn.disabled = true;
    } else {
      fileNote.textContent = `Attached: ${file.name} (${Math.round(file.size/1024)}KB)`;
      fileNote.style.color = '';
      uploadBtn.disabled = !currentUser;
    }
  });

  function readFileAsDataURL(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  [filterCourse, filterYear, filterSubject].forEach(el => el.addEventListener('change', render));
  searchBox.addEventListener('input', render);
  followingOnlyToggle.addEventListener('change', render);
})();