export const CHAT_RUNTIME_INPUT_SNIPPET = String.raw`
function createChatInputGuardRuntime() {
  let inFlight = false;
  return {
    isLocked() {
      return inFlight;
    },
    lock() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    unlock() {
      inFlight = false;
    },
  };
}

function bindChatInputEnterRuntime(inputLike, onEnterLike) {
  const input = inputLike || null;
  const onEnter = typeof onEnterLike === 'function' ? onEnterLike : null;
  if (!input || !onEnter) return false;
  input.addEventListener('keydown', function(ev) {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    onEnter();
  });
  return true;
}
`;
