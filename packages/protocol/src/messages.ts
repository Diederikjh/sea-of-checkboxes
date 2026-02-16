import {
  MAX_TILES_SUBSCRIBED,
  TILE_CELL_COUNT,
  TILE_ENCODING,
  WORLD_MAX,
  isCellIndexValid,
} from "@sea/domain";
import { z } from "zod";

function strictTaggedMessage<TTag extends string, TShape extends z.ZodRawShape>(
  tag: TTag,
  shape: TShape
) {
  return z
    .object({
      t: z.literal(tag),
      ...shape,
    })
    .strict();
}

export function hasValidVersionRange(fromVer: number, toVer: number): boolean {
  return toVer >= fromVer;
}

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

export const subMessageSchema = strictTaggedMessage("sub", {
  tiles: z.array(tileKeySchema).max(MAX_TILES_SUBSCRIBED),
});

export const unsubMessageSchema = strictTaggedMessage("unsub", {
  tiles: z.array(tileKeySchema).max(MAX_TILES_SUBSCRIBED),
});

export const setCellMessageSchema = strictTaggedMessage("setCell", {
  tile: tileKeySchema,
  i: cellIndexSchema,
  v: bitValueSchema,
  op: z.string().min(1),
});

export const cursorMessageSchema = strictTaggedMessage("cur", {
  x: boundedWorldNumberSchema,
  y: boundedWorldNumberSchema,
});

export const resyncTileMessageSchema = strictTaggedMessage("resyncTile", {
  tile: tileKeySchema,
  haveVer: nonNegativeIntSchema,
});

export const clientMessageSchema = z.discriminatedUnion("t", [
  subMessageSchema,
  unsubMessageSchema,
  setCellMessageSchema,
  cursorMessageSchema,
  resyncTileMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const helloMessageSchema = strictTaggedMessage("hello", {
  uid: z.string().min(1),
  name: z.string().min(1),
});

export const tileSnapshotSchema = strictTaggedMessage("tileSnap", {
  tile: tileKeySchema,
  ver: nonNegativeIntSchema,
  enc: z.literal(TILE_ENCODING),
  bits: z.string().min(1),
});

export const cellUpdateSchema = strictTaggedMessage("cellUp", {
  tile: tileKeySchema,
  i: cellIndexSchema,
  v: bitValueSchema,
  ver: nonNegativeIntSchema,
});

export const cellUpdateBatchSchema = strictTaggedMessage("cellUpBatch", {
  tile: tileKeySchema,
  fromVer: nonNegativeIntSchema,
  toVer: nonNegativeIntSchema,
  ops: z.array(z.tuple([cellIndexSchema, bitValueSchema])),
});

export const cursorUpdateSchema = strictTaggedMessage("curUp", {
  uid: z.string().min(1),
  name: z.string().min(1),
  x: boundedWorldNumberSchema,
  y: boundedWorldNumberSchema,
});

export const errorMessageSchema = strictTaggedMessage("err", {
  code: z.string().min(1),
  msg: z.string().min(1),
});

const serverMessageDiscriminatedSchema = z.discriminatedUnion("t", [
  helloMessageSchema,
  tileSnapshotSchema,
  cellUpdateSchema,
  cellUpdateBatchSchema,
  cursorUpdateSchema,
  errorMessageSchema,
]);

export const serverMessageSchema = serverMessageDiscriminatedSchema.superRefine((value, ctx) => {
  if (value.t === "cellUpBatch" && !hasValidVersionRange(value.fromVer, value.toVer)) {
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
