import { z } from 'zod';
import type { DocumentSettings } from '../types';

/**
 * The PDF made of each response: what it shows, how, and whether it is kept, sealed or made to the archival
 * standard. It names the form's fields (to leave out, to start a page) and nothing else.
 */
export const documentSettingsSchema: z.ZodType<DocumentSettings> = z.object({ keep: z.boolean().optional(), title: z.string().max(150).optional(), footer: z.string().max(200).optional(), showEmpty: z.boolean().optional(), leaveOut: z.array(z.string().max(100)).max(200).optional(), note: z.string().max(2000).optional(), newPage: z.array(z.string().max(100)).max(100).optional(), archival: z.boolean().optional(), seal: z.boolean().optional(), font: z.enum(['sans', 'serif']).optional(), ownPdf: z.object({ id: z.string().min(1).max(64), name: z.string().max(100), map: z.record(z.string().max(200), z.string().max(100)).optional() }).optional() });
