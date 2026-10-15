import { Request, Response } from 'express';
import prisma from '../config/database';

/**
 * GET /api/classes/:classId/students
 * Pobiera wszystkich uczniów z klasy
 */
export async function getStudents(req: Request, res: Response): Promise<void> {
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

    const students = await prisma.student.findMany({
      where: { class_id: classId },
      orderBy: { created_at: 'asc' },
    });

    res.json({ students });
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/classes/:classId/students
 * Dodaje nowego ucznia do klasy (z zaszyfrowanymi danymi)
 */
export async function createStudent(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { classId } = req.params;
    const { encrypted_first_name, encrypted_last_name, encrypted_number } = req.body;

    // Walidacja
    if (!encrypted_first_name || !encrypted_last_name || !encrypted_number) {
      res.status(400).json({ error: 'All encrypted fields are required' });
      return;
    }

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

    const student = await prisma.student.create({
      data: {
        class_id: classId,
        encrypted_first_name,
        encrypted_last_name,
        encrypted_number,
      },
    });

    res.status(201).json({ student });
  } catch (error) {
    console.error('Create student error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PUT /api/students/:studentId
 * Aktualizuje dane ucznia (zaszyfrowane)
 */
export async function updateStudent(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { studentId } = req.params;
    const { encrypted_first_name, encrypted_last_name, encrypted_number } = req.body;

    // Sprawdź czy uczeń należy do klasy użytkownika
    const student = await prisma.student.findFirst({
      where: { id: studentId },
      include: {
        class: true,
      },
    });

    if (!student || student.class.user_id !== req.user.userId) {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    const updatedStudent = await prisma.student.update({
      where: { id: studentId },
      data: {
        encrypted_first_name: encrypted_first_name || student.encrypted_first_name,
        encrypted_last_name: encrypted_last_name || student.encrypted_last_name,
        encrypted_number: encrypted_number || student.encrypted_number,
      },
    });

    res.json({ student: updatedStudent });
  } catch (error) {
    console.error('Update student error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/students/:studentId
 * Usuwa ucznia
 */
export async function deleteStudent(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { studentId } = req.params;

    // Sprawdź czy uczeń należy do klasy użytkownika
    const student = await prisma.student.findFirst({
      where: { id: studentId },
      include: {
        class: true,
      },
    });

    if (!student || student.class.user_id !== req.user.userId) {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    await prisma.student.delete({
      where: { id: studentId },
    });

    res.json({ message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
