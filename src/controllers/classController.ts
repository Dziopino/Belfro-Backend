import { Request, Response } from 'express';
import prisma from '../config/database';

/**
 * GET /api/classes
 * Pobiera wszystkie klasy zalogowanego użytkownika
 */
export async function getClasses(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const classes = await prisma.class.findMany({
      where: { user_id: req.user.userId },
      include: {
        students: true,
        _count: {
          select: { students: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ classes });
  } catch (error) {
    console.error('Get classes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/classes
 * Tworzy nową klasę (z zaszyfrowaną nazwą)
 */
export async function createClass(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { encrypted_name } = req.body;

    if (!encrypted_name) {
      res.status(400).json({ error: 'Encrypted class name is required' });
      return;
    }

    const newClass = await prisma.class.create({
      data: {
        user_id: req.user.userId,
        encrypted_name,
      },
      include: {
        students: true,
        _count: {
          select: { students: true },
        },
      },
    });

    res.status(201).json({ class: newClass });
  } catch (error) {
    console.error('Create class error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/classes/:classId
 * Pobiera szczegóły pojedynczej klasy wraz z uczniami
 */
export async function getClass(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { classId } = req.params;

    const classData = await prisma.class.findFirst({
      where: {
        id: classId,
        user_id: req.user.userId, // Tylko własne klasy
      },
      include: {
        students: {
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!classData) {
      res.status(404).json({ error: 'Class not found' });
      return;
    }

    res.json({ class: classData });
  } catch (error) {
    console.error('Get class error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/classes/:classId
 * Usuwa klasę (wraz ze wszystkimi uczniami - CASCADE)
 */
export async function deleteClass(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { classId } = req.params;

    // Sprawdź czy klasa należy do użytkownika
    const classData = await prisma.class.findFirst({
      where: {
        id: classId,
        user_id: req.user.userId,
      },
    });

    if (!classData) {
      res.status(404).json({ error: 'Class not found' });
      return;
    }

    // Usuń klasę (uczniowie zostaną usunięci automatycznie przez CASCADE)
    await prisma.class.delete({
      where: { id: classId },
    });

    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Delete class error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
