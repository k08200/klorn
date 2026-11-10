// Test worker: an extraction that keeps allocating until the heap limit stops
// it (attachment-extract-isolated).
const hoard = [];
for (;;) {
  hoard.push(new Array(1_000_000).fill(hoard.length));
}
