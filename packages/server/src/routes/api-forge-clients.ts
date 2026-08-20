/**
 * VOLUND FORGE — clients (top-level customer / org) REST API.
 *
 * TODO(forge-perms): gate should narrow to `forge:read` / `forge:write`
 * once we create those permissions and migrate the FORGE consumer roles.
 * For PR1 we reuse `admin:users` so admin operators can populate clients
 * without an extra role binding.
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as clientsDb from '@archon/core/db/clients';
import { recordAuditLog } from '@archon/core/db/audit-log';
import { createClientBodySchema, updateClientBodySchema, type Client } from '@archon/core/schemas';

type ApiErrorStatus = 400 | 404 | 409;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

const clients = new Hono();

// GET /api/forge/clients
clients.get('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const rows = await clientsDb.listClients();
  return c.json({ clients: rows });
});

// POST /api/forge/clients
clients.post('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = createClientBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid client body', parsed.error.message);
  }
  try {
    const created = await clientsDb.createClient({
      slug: parsed.data.slug,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      contact_email: parsed.data.contact_email ?? null,
    });
    // Audit: client.created
    await recordAuditLog({
      action: 'client.created',
      entityType: 'client',
      entityId: created.id,
      actorId: guard.userId,
      metadata: { slug: created.slug, name: created.name },
    });
    return c.json({ client: created satisfies Client }, 201);
  } catch (e) {
    const err = e as Error;
    if (err.message.includes('duplicate') || err.message.includes('UNIQUE')) {
      return apiError(c, 409, `A client with slug "${parsed.data.slug}" already exists`);
    }
    throw e;
  }
});

// GET /api/forge/clients/:id
clients.get('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const row = await clientsDb.getClientById(id);
  if (!row) return apiError(c, 404, 'Client not found');
  return c.json({ client: row });
});

// PATCH /api/forge/clients/:id
clients.patch('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = updateClientBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid client body', parsed.error.message);
  }
  const updated = await clientsDb.updateClient(id, {
    name: parsed.data.name,
    description: parsed.data.description,
    contact_email: parsed.data.contact_email,
    status: parsed.data.status,
  });
  if (!updated) return apiError(c, 404, 'Client not found');
  // Audit: client.updated (only include fields that actually changed)
  await recordAuditLog({
    action: 'client.updated',
    entityType: 'client',
    entityId: id,
    actorId: guard.userId,
    metadata: {
      changes: Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
    },
  });
  return c.json({ client: updated });
});

// DELETE /api/forge/clients/:id — refuses if the client still owns
// codebases or demands (safer than cascading through 100s of rows).
clients.delete('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const result = await clientsDb.deleteClient(id);
  if (!result.deleted) {
    return c.json(
      { error: result.reason ?? 'Não foi possível remover o cliente' },
      result.reason?.includes('não encontrado') ? 404 : 409
    );
  }
  // Audit: client.deleted
  await recordAuditLog({
    action: 'client.deleted',
    entityType: 'client',
    entityId: id,
    actorId: guard.userId,
  });
  return c.json({ ok: true });
});

export default clients;
