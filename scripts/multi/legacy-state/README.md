Team server state files exactly as Baton 0.0.0 (commit 360bfda) wrote them,
before files were versioned. The multi-machine harness copies them into the
server's state dir before `baton serve` starts, and `pnpm test:multi` checks
the note, handoff and canvas position all survive the upgrade.
