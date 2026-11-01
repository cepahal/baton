import { BATON_EVENT_KINDS } from "@baton/core";

export function App() {
  return (
    <main>
      <h1>Baton</h1>
      <p>Live feed coming soon. Event kinds: {BATON_EVENT_KINDS.join(", ")}</p>
    </main>
  );
}
