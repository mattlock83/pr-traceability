export function event(fields = {}) {
  return {
    sender: { type: 'Bot' },
    pull_request: { number: 42, ...fields },
  };
}
