import { NodeIO, PropertyType } from '@gltf-transform/core';
import { dedup, flatten, join, prune } from '@gltf-transform/functions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { promises as fs } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) throw new Error('Usage: node tools/optimize-glb.mjs INPUT.glb OUTPUT.glb');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(input);
const count = () => ({ nodes: document.getRoot().listNodes().length, meshes: document.getRoot().listMeshes().length, primitives: document.getRoot().listMeshes().reduce((n, mesh) => n + mesh.listPrimitives().length, 0) });
const before = count();
await document.transform(
  dedup({ propertyTypes: [PropertyType.MATERIAL] }),
  flatten(),
  join({ keepNamed: false }),
  prune(),
);
const after = count();
await io.write(output, document);
const bytes = (await fs.stat(output)).size;
process.stdout.write(`${JSON.stringify({ before, after, bytes })}\n`);
