import { z } from 'zod';

// The four structured-output contracts an LLMProvider validates against.
// Field-for-field as specified — no drift (spec §8, §9, §13, §14).

export const ContextualizedQuerySchema = z.object({
  standaloneQuery: z.string().min(3).max(400),
  usedHistory: z.boolean(),
  resolvedReferences: z.array(z.string()).max(5), // e.g. ["it" → "normalization"]
});
export type ContextualizedQuery = z.infer<typeof ContextualizedQuerySchema>;

export const QueryPlanSchema = z.object({
  contextualizedQuery: z.string().min(3).max(400),
  rewrittenQuery: z.string().min(3).max(400).nullable(),
  stepBackQuery: z.string().min(3).max(400).nullable(),
  subQueries: z.array(z.string().min(3).max(400)).max(3),
  rationale: z.string().max(500), // logged, never returned to the user
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

export const EvidenceAssessmentSchema = z.object({
  verdict: z.enum(['sufficient', 'partial', 'insufficient', 'conflicting']),
  rationale: z.string().max(800),
  supportingSourceIds: z.array(z.string()).max(20),
  conflictingSourceIds: z.array(z.string()).max(20),
  missingInformation: z.array(z.string().max(200)).max(5),
});
export type EvidenceAssessment = z.infer<typeof EvidenceAssessmentSchema>;

export const AnswerSchema = z.object({
  answer: z.string().min(1).max(8000),
  citedSourceIds: z.array(z.string()).max(20),
  usedGeneralKnowledge: z.boolean(),
});
export type Answer = z.infer<typeof AnswerSchema>;
