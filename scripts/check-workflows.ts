import postgres from 'postgres';
import { WorkflowSchema } from '@aflow/schemas';

async function main() {
  const sql = postgres('postgres://phoenix:phoenix@localhost:5433/phoenix');
  const rows = await sql.unsafe(`
    SELECT inline_content, path FROM "t_a0000000000000000000000000000001".memory_docs 
    WHERE path LIKE '/workflows/%/workflow.json' AND deleted_at IS NULL 
    AND space_id = '31561b8c-2ceb-4b6c-aad1-6edbe5bacd66' ORDER BY path
  `);
  for (const row of rows) {
    const raw = JSON.parse(row.inline_content as string);
    const result = WorkflowSchema.safeParse(raw);
    if (!result.success) {
      console.log(
        'FAIL',
        raw.slug,
        ':',
        result.error.issues[0]?.message,
        'at',
        JSON.stringify(result.error.issues[0]?.path),
      );
    } else {
      console.log('OK  ', raw.slug);
    }
  }
  await sql.end();
}
main().catch((e: unknown) => {
  if (e instanceof Error) {
    console.error(e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
});
