"""Export only the native review model from a Blender file.

Run: Blender --background --python tools/export_glb.py -- --input MODEL.blend --output B_R33.glb --revision R33
The source .blend is opened but never saved.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--revision', required=True)
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def main():
    args = parse_args()
    source = Path(args.input).resolve()
    target = Path(args.output).resolve()
    if source == target or not source.is_file():
        raise ValueError('Source .blend missing or output overlaps source')
    before = digest(source)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    collection = bpy.data.collections.get('MODEL_NATIVE')
    if not collection:
        raise RuntimeError('MODEL_NATIVE collection missing')
    scene = bpy.context.scene
    if 'MODEL' in scene.view_layers:
        bpy.context.window.view_layer = scene.view_layers['MODEL']
    view_layer = bpy.context.view_layer
    for obj in bpy.data.objects:
        obj.select_set(False)
    included = []
    excluded = []
    for obj in collection.all_objects:
        if obj.type not in {'MESH', 'CURVE', 'FONT', 'SURFACE', 'META'}:
            excluded.append({'name': obj.name, 'reason': f'type:{obj.type}'})
            continue
        if obj.hide_render or obj.hide_get(view_layer=view_layer):
            excluded.append({'name': obj.name, 'reason': 'hidden'})
            continue
        obj.select_set(True)
        included.append(obj)
    if not included:
        raise RuntimeError('No visible native geometry selected')
    bpy.context.view_layer.objects.active = included[0]
    coords = [obj.matrix_world @ Vector(corner) for obj in included for corner in obj.bound_box]
    bounds = {
        'min': [min(p[i] for p in coords) for i in range(3)],
        'max': [max(p[i] for p in coords) for i in range(3)],
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=str(target), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_animations=False,
        export_cameras=False, export_lights=False, export_extras=False,
        export_materials='EXPORT', export_normals=True,
    )
    if result != {'FINISHED'} or not target.is_file() or target.stat().st_size < 1000:
        raise RuntimeError(f'GLB export failed: {result}')
    if digest(source) != before:
        raise RuntimeError('Source .blend changed during export')
    report = {
        'schema_version': 1, 'model_revision': args.revision,
        'source_blend': str(source), 'source_sha256': before,
        'glb_path': str(target), 'glb_sha256': digest(target), 'glb_bytes': target.stat().st_size,
        'blender_version': bpy.app.version_string,
        'exporter_version': f'Blender bundled glTF exporter ({bpy.app.version_string})',
        'included_collection': 'MODEL_NATIVE', 'excluded_collections': ['SCAN_3DGS'],
        'object_count': len(included), 'mesh_count': sum(obj.type == 'MESH' for obj in included),
        'materials': sorted({mat.name for obj in included if obj.data and hasattr(obj.data, 'materials') for mat in obj.data.materials if mat}),
        'excluded_objects': excluded,
        'bounds_project': bounds,
        'asset_to_project': [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]],
        'matrix_convention': 'row-major, homogeneous column vectors; glTF Y-up to project Z-up',
        'export_settings': {'format': 'GLB', 'use_selection': True, 'export_yup': True, 'export_apply': True, 'export_animations': False},
        'warnings': [],
    }
    report_path = target.with_suffix('.export.json')
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('GLB_EXPORT_REPORT=' + str(report_path), flush=True)


if __name__ == '__main__':
    main()
