// Where a job's gallery lives. A store obeys the job service: it prepares the gallery (locked), unlocks it once paid, locks it on a
// refund. MockStore runs with no accounts (the gallery is a page of this app); TarkleStore delivers into the client's Tarkle portal.

export function createMockStore({ baseUrl }) {
  const unlocked = new Set();
  return {
    kind: "mock",
    async prepare(job) {
      return { clientUrl: `${baseUrl}/client/${job.id}?key=${job.accessKey}` };
    },
    async unlock(job) {
      unlocked.add(job.id);
    },
    async lock(job) {
      unlocked.delete(job.id);
    },
    isUnlocked: (job) => unlocked.has(job.id),
    deliveryOf: () => null,
    adopt(job, _delivery, isUnlocked = false) {
      if (isUnlocked) unlocked.add(job.id);
    },
  };
}
