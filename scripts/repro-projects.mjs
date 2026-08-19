// Reproduce listProjectsWithCounts against the shared Postgres
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://archon:Hos_8K3mN9pL2qR7vT5wX1yA4bC6dE0fG@213.199.32.229:5432/HarnessOS?sslmode=disable',
  ssl: false,
});

const query = `
SELECT
  cb.id,
  cb.name,
  cb.client_id,
  c.name AS client_name,
  cb.kind AS status,
  cb.default_branch,
  cb.repository_url,
  (SELECT COUNT(*) FROM remote_agent_demands d
    WHERE d.codebase_id = cb.id
      AND d.status NOT IN ('concluido', 'cancelado')) AS open_demands,
  (SELECT COUNT(*) FROM remote_agent_demands d
    WHERE d.codebase_id = cb.id) AS total_demands,
  (SELECT COUNT(*) FROM remote_agent_workflow_runs wr
    WHERE wr.codebase_id = cb.id) AS runs_count
FROM remote_agent_codebases cb
LEFT JOIN remote_agent_clients c ON c.id = cb.client_id
ORDER BY cb.name ASC
`;

try {
  const result = await pool.query(query);
  console.log('OK — rows:', result.rows.length);
  console.log('first row:', JSON.stringify(result.rows[0], null, 2));
} catch (e) {
  console.log('ERROR:', e.message);
  console.log('code:', e.code);
  console.log('detail:', e.detail);
  console.log('hint:', e.hint);
  console.log('position:', e.position);
}

await pool.end();
