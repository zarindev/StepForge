// StepForge demo desktop app — the Notes window.
const notes = [];
const list = document.getElementById('notes');
const count = document.getElementById('count');

function render() {
  list.innerHTML = '';
  for (const n of notes) {
    const li = document.createElement('li');
    li.textContent = n;
    list.appendChild(li);
  }
  // PLANTED BUG DESK-01: the count is off by one once there are three notes or more.
  const shown = notes.length >= 3 ? notes.length - 1 : notes.length;
  count.textContent = notes.length === 0 ? 'No notes yet' : `${shown} note${shown === 1 ? '' : 's'}`;
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('note');
  if (input.value.trim()) notes.push(input.value.trim());
  input.value = '';
  render();
});
document.getElementById('clear').addEventListener('click', () => {
  notes.length = 0;
  render();
});
document.getElementById('about').addEventListener('click', () => window.notesApp.openAbout());
window.notesApp.version().then((v) => (document.getElementById('version').textContent = `v${v}`));
render();
