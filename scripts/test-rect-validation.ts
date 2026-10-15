/*
 * Test walidacji prostokąta w uploadAndAnonymizeImage — wywołuje prawdziwy kontroler z podstawionym
 * req/res. Ścieżki odmowy nic nie zapisują; ostatni przypadek pozytywny celowo tworzy wiersz Grade
 * i plik w uploads, po czym oba usuwa. Nie uruchamiaj, gdy w wybranej sesji trwa realna praca.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import prisma from '../src/config/database';
import { uploadAndAnonymizeImage } from '../src/controllers/gradingController';

function makeRes() {
  const out: any = { statusCode: 0, body: null };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (body: any) => { out.body = body; return out; };
  return out;
}

async function sensorJpeg(orientation: number) {
  const W = 600, H = 1000;
  const px = Buffer.alloc(W * H * 3, 200);
  return sharp(px, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 80 })
    .withMetadata({ orientation })
    .toBuffer();
}

async function main() {
  // Para bez istniejącego Grade: aktualizacja nadpisałaby ai_response i confidence_score ucznia
  const sessions = await prisma.gradingSession.findMany({
    where: { status: 'in_progress' },
    include: { class: { include: { students: true } } },
    take: 10,
  });

  let session: (typeof sessions)[number] | undefined;
  let student: (typeof sessions)[number]['class']['students'][number] | undefined;

  for (const s of sessions) {
    for (const candidate of s.class.students) {
      const existing = await prisma.grade.findFirst({ where: { grading_session_id: s.id, student_id: candidate.id } });
      if (!existing) { session = s; student = candidate; break; }
    }
    if (session && student) break;
  }

  if (!session || !student) { console.log('Brak wolnej pary sesja/uczeń (bez istniejącego Grade) — pomijam'); process.exit(0); }

  const jpeg = await sensorJpeg(6); // kadr po obrocie: 1000x600
  console.log(`rama po obrocie = 1000x600 (piksele 600x1000, orientation 6)`);

  const cases = [
    { name: 'prostopadł poza kadrem (x=2000)', rect: { x: '2000', y: '10', width: '100', height: '40' } },
    { name: 'zerowy szerokość', rect: { x: '10', y: '10', width: '0', height: '40' } },
    { name: 'ujemne współrzędne', rect: { x: '-50', y: '-50', width: '20', height: '20' } },
    { name: 'zasłania całą kartkę', rect: { x: '0', y: '0', width: '1000', height: '600' } },
    { name: 'uszkodzony plik', rect: { x: '10', y: '10', width: '50', height: '20' }, broken: true },
    { name: 'PRZYPADEK POZYTYWNY: wystaje za kadr', rect: { x: '950', y: '500', width: '100', height: '50' } },
  ];

  const uploadsDir = path.join(process.cwd(), 'uploads', 'anonymized');
  const beforeGrades = await prisma.grade.findMany({ where: { grading_session_id: session.id }, select: { id: true } });
  const beforeFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];

  for (const c of cases) {
    const req: any = {
      user: { userId: session.user_id },
      file: { buffer: c.broken ? Buffer.from('to nie jest obraz') : jpeg, mimetype: 'image/jpeg' },
      body: { student_id: student.id, session_id: session.id, ...c.rect },
    };
    const res = makeRes();
    await uploadAndAnonymizeImage(req, res);
    console.log(`${c.name.padEnd(34)} -> ${res.statusCode} ${res.body?.code ?? '-'} ${JSON.stringify(res.body?.error ?? res.body)}`);
  }

  // Sprzątanie: wszystko, co test mimo wszystko zapisał, nie powinno zostać
  const afterGrades = await prisma.grade.findMany({ where: { grading_session_id: session.id }, select: { id: true } });
  const newGrades = afterGrades.map((g) => g.id).filter((id) => !beforeGrades.some((b) => b.id === id));
  const afterFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
  const newFiles = afterFiles.filter((f) => !beforeFiles.includes(f));

  for (const id of newGrades) await prisma.grade.delete({ where: { id } });

  for (const f of newFiles) {
    const file = path.join(uploadsDir, f);
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] >= 253 && data[i + 1] >= 253 && data[i + 2] >= 253) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    console.log(`\nZapisany plik ${f}: wymiary ${info.width}x${info.height}, biały prostokąt = ${minX},${minY} ${maxX - minX + 1}x${maxY - minY + 1} (oczekiwane 950,500 50x50)`);
    fs.unlinkSync(file);
  }

  console.log(`\nPosprzątane po przypadku pozytywnym: ${newGrades.length} wierszy Grade, ${newFiles.length} plików.`);
  if (newGrades.length > 1 || newFiles.length > 1) {
    console.log('UWAGA: zapisów było więcej niż jeden, więc któreś odrzucenie nie zadziałało.');
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
