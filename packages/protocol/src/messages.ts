import {
  MAX_TILES_SUBSCRIBED,
  TILE_CELL_COUNT,
  TILE_ENCODING,
  WORLD_MAX,
  isCellIndexValid,
} from "@sea/domain";
import { z } from "zod";

const tileKeySchema = z.string().regex(/^-?\d+:-?\d+$/);
const bitValueSchema = z.union([z.literal(0), z.literal(1)]);

const finiteNumberSchema = z.number().refine((value) => Number.isFinite(value), {
  message: "Expected finite number",
});

const boundedWorldNumberSchema = finiteNumberSchema.refine((value) => Math.abs(value) <= WORLD_MAX, {
  message: `Expected number in [-${WORLD_MAX}, ${WORLD_MAX}]`,
});

const nonNegativeIntSchema = z.number().int().min(0);

const cellIndexSchema = nonNegativeIntSchema.refine((value) => isCellIndexValid(value), {
  message: `Expected valid cell index [0, ${TILE_CELL_COUNT - 1}]`,
});

export const subMessageSchema = z
  .object({
    t: z.literal("sub"),
    tiles: z.array(tileKeySchema).max(MAX_TILES_SUBSCRIBED),
  })
  .strict();

export const unsubMessageSchema = z
  .object({
    t: z.literal("unsub"),
    tiles: z.array(tileKeySchema).max(MAX_TILES_SUBSCRIBED),
  })
  .strict();

export const setCellMessageSchema = z
  .object({
    t: z.literal("setCell"),
    tile: tileKeySchema,
    i: cellIndexSchema,
    v: bitValueSchema,
    op: z.string().min(1),
  })
  .strict();

export const cursorMessageSchema = z
  .object({
    t: z.literal("cur"),
    x: boundedWorldNumberSchema,
    y: boundedWorldNumberSchema,
  })
  .strict();

export const resyncTileMessageSchema = z
  .object({
    t: z.literal("resyncTile"),
    tile: tileKeySchema,
    haveVer: nonNegativeIntSchema,
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion("t", [
  subMessageSchema,
  unsubMessageSchema,
  setCellMessageSchema,
  cursorMessageSchema,
  resyncTileMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const helloMessageSchema = z
  .object({
    t: z.literal("hello"),
    uid: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const tileSnapshotSchema = z
  .object({
    t: z.literal("tileSnap"),
    tile: tileKeySchema,
    ver: nonNegativeIntSchema,
    enc: z.literal(TILE_ENCODING),
    bits: z.string().min(1),
  })
  .strict();

export const cellUpdateSchema = z
  .object({
    t: z.literal("cellUp"),
    tile: tileKeySchema,
    i: cellIndexSchema,
    v: bitValueSchema,
    ver: nonNegativeIntSchema,
  })
  .strict();

export const cellUpdateBatchSchema = z
  .object({
    t: z.literal("cellUpBatch"),
    tile: tileKeySchema,
    fromVer: nonNegativeIntSchema,
    toVer: nonNegativeIntSchema,
    ops: z.array(z.tuple([cellIndexSchema, bitValueSchema])),
  })
  .strict();

export const cursorUpdateSchema = z
  .object({
    t: z.literal("curUp"),
    uid: z.string().min(1),
    name: z.string().min(1),
    x: boundedWorldNumberSchema,
    y: boundedWorldNumberSchema,
  })
  .strict();

export const errorMessageSchema = z
  .object({
    t: z.literal("err"),
    code: z.string().min(1),
    msg: z.string().min(1),
  })
  .strict();

const serverMessageDiscriminatedSchema = z.discriminatedUnion("t", [
  helloMessageSchema,
  tileSnapshotSchema,
  cellUpdateSchema,
  cellUpdateBatchSchema,
  cursorUpdateSchema,
  errorMessageSchema,
]);

export const serverMessageSchema = serverMessageDiscriminatedSchema.superRefine((value, ctx) => {
  if (value.t === "cellUpBatch" && value.toVer < value.fromVer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "toVer must be >= fromVer",
      path: ["toVer"],
    });
  }
});

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(input: unknown): ClientMessage {
  return clientMessageSchema.parse(input);
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input);
}
