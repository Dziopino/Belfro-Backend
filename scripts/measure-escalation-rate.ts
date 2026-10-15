/*
 * Ile prac faktycznie ląduje w drogim modelu? Skrypt tylko czyta bazę (grade.model_used /
 * grade.escalated) i drukuje zbiorcze liczniki. Nie woła AI, nie zapisuje, nic nie kasuje.
 */
import path from 'path';
import dotenv from 'dotenv';
import prisma from '../src/config/database';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main(): Promise<void> {
  const total = await prisma.grade.count();
  const byModel = await prisma.grade.groupBy({
    by: ['model_used'],
    _count: { _all: true },
    _avg: { confidence_score: true },
  });
  const escalatedTrue = await prisma.grade.count({ where: { escalated: true } });
  const escalatedNull = await prisma.grade.count({ where: { escalated: null } });
  const sessions = await prisma.gradingSession.count();

  console.log(`sessions=${sessions} grades=${total}`);
  for (const row of byModel) {
    const share = total ? ((row._count._all / total) * 100).toFixed(1) : '0';
    const conf = row._avg.confidence_score?.toFixed(1) ?? '-';
    console.log(`model=${row.model_used ?? 'null'} count=${row._count._all} share=${share}% avg_conf=${conf}`);
  }
  console.log(`escalated_true=${escalatedTrue} escalated_null=${escalatedNull}`);

  const lowConf = await prisma.grade.count({ where: { confidence_score: { lt: 75 } } });
  console.log(`confidence_below_75=${lowConf} (${total ? ((lowConf / total) * 100).toFixed(1) : '0'}%)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
