const API = `http://localhost:${process.env.CW_API_PORT ?? 8799}`;
const MGMT = `${API}/spaces/space-1/environments/master`;
const HEADERS = { authorization: 'Bearer dev-cma-key', 'content-type': 'application/json' };

/** Seeds a published "article" content type so the e2e can author + publish an entry. */
export default async function globalSetup() {
  // Wait for the API to accept requests (the webServer port check races with seeding).
  for (let i = 0; i < 50; i++) {
    try {
      const ping = await fetch(`${MGMT}/content-types`, { headers: HEADERS });
      if (ping.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const create = await fetch(`${MGMT}/content-types`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: true,
          required: true,
          position: 0,
        },
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    }),
  });
  if (!create.ok && create.status !== 409) {
    throw new Error(`seed content type failed: ${create.status} ${await create.text()}`);
  }
  await fetch(`${MGMT}/content-types/article/published`, { method: 'POST', headers: HEADERS });
}
