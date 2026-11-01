export function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className={`live-dot${live ? " is-live" : ""}`}
      role="img"
      aria-label={live ? "Live" : "Idle"}
      title={live ? "Live" : "Idle"}
    />
  );
}
