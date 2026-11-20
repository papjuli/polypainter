"""Hangs a solid exported from PolyPainter in a dark room as a lamp shade.

A small, bright bulb at the solid's center shines out only where the paint
is transparent, so every hole throws a spot of light onto the walls. Run it
with Blender, not the venv's Python:

    blender --python tools/lamp_shade.py -- polypainter-cube.glb

Blender opens looking through the camera, rendering the room as it will
look. Press F12 for a finished image.
"""

import sys

import bmesh
import bpy
from mathutils import Vector

# Sizes in meters. The room is centered on the origin, with its floor at 0.
ROOM = Vector((4.0, 4.0, 2.6))
SHADE_RADIUS = 0.2
SHADE_HEIGHT = 1.7
# The smaller the bulb, the sharper the spots on the walls. Its power is high
# because only the light through the holes gets out of the shade.
BULB_RADIUS = 0.002
BULB_POWER = 400
BULB_COLOR = (1.0, 0.78, 0.55)
# The cord hangs from the ceiling down to the middle of the shade, ending just
# above the bulb: a bulb inside the end of the cord would be shut in by it.
CORD_RADIUS = 0.003
CORD_GAP = 0.015
CORD_COLOR = (0.9, 0.9, 0.88, 1.0)
WALL_COLOR = (0.8, 0.8, 0.78, 1.0)
FLOOR_COLOR = (0.35, 0.3, 0.26, 1.0)
CAMERA = Vector((1.75, -1.75, 0.9))
CAMERA_TARGET = Vector((-0.6, 0.6, 1.75))
CAMERA_LENS = 16


def material(name, color, roughness=0.9):
    result = bpy.data.materials.new(name)
    # Blender 5 gives new materials their nodes; earlier versions must be
    # asked for them.
    if result.node_tree is None:
        result.use_nodes = True
    bsdf = result.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = roughness
    result.diffuse_color = color
    return result


def add_object(name, mesh_or_data):
    obj = bpy.data.objects.new(name, mesh_or_data)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def look_at(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat('-Z', 'Y').to_euler()


def import_shade(path):
    bpy.ops.import_scene.gltf(filepath=path)
    shade = next(obj for obj in bpy.context.selected_objects if obj.type == 'MESH')
    # The importer puts the solid in a collection of its own, and may parent
    # it to an empty, so it is moved into the scene as a plain object.
    scene = bpy.context.scene
    shade.parent = None
    for collection in list(shade.users_collection):
        collection.objects.unlink(shade)
        if collection != scene.collection and not collection.all_objects:
            bpy.data.collections.remove(collection)
    scene.collection.objects.link(shade)
    radius = max(vertex.co.length for vertex in shade.data.vertices)
    shade.scale = [SHADE_RADIUS / radius] * 3
    shade.location = (0, 0, SHADE_HEIGHT)


def add_room():
    # A box seen from the inside, so its faces point inward.
    mesh = bpy.data.meshes.new('Room')
    shape = bmesh.new()
    bmesh.ops.create_cube(shape, size=1)
    bmesh.ops.scale(shape, vec=ROOM, verts=shape.verts)
    bmesh.ops.translate(shape, vec=(0, 0, ROOM.z / 2), verts=shape.verts)
    bmesh.ops.reverse_faces(shape, faces=shape.faces)
    for face in shape.faces:
        face.material_index = 1 if face.normal.z > 0.5 else 0
    shape.to_mesh(mesh)
    shape.free()
    mesh.materials.append(material('Walls', WALL_COLOR))
    mesh.materials.append(material('Floor', FLOOR_COLOR))
    add_object('Room', mesh)


def add_cord():
    bottom = SHADE_HEIGHT + CORD_GAP
    mesh = bpy.data.meshes.new('Cord')
    shape = bmesh.new()
    bmesh.ops.create_cone(
        shape, segments=12, radius1=CORD_RADIUS, radius2=CORD_RADIUS, depth=ROOM.z - bottom, cap_ends=True
    )
    shape.to_mesh(mesh)
    shape.free()
    mesh.materials.append(material('Cord', CORD_COLOR, roughness=0.5))
    cord = add_object('Cord', mesh)
    cord.location = (0, 0, (ROOM.z + bottom) / 2)


def add_bulb():
    light = bpy.data.lights.new('Bulb', 'POINT')
    light.energy = BULB_POWER
    light.shadow_soft_size = BULB_RADIUS
    light.color = BULB_COLOR
    add_object('Bulb', light).location = (0, 0, SHADE_HEIGHT)


def add_camera():
    camera = add_object('Camera', bpy.data.cameras.new('Camera'))
    camera.data.lens = CAMERA_LENS
    camera.location = CAMERA
    look_at(camera, CAMERA_TARGET)
    bpy.context.scene.camera = camera


def set_up_rendering():
    scene = bpy.context.scene
    # Cycles traces the light through the holes; Blender's faster EEVEE
    # engine shows the spots only roughly.
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 256
    scene.cycles.preview_samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.use_preview_denoising = True
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    # Looks through the camera at the rendered room.
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.shading.type = 'RENDERED'
                area.spaces.active.region_3d.view_perspective = 'CAMERA'


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(args) != 1:
        sys.exit('Usage: blender --python tools/lamp_shade.py -- <exported .glb file>')
    # Starts from an empty scene, without Blender's default cube, light and
    # camera.
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    import_shade(args[0])
    add_room()
    add_cord()
    add_bulb()
    add_camera()
    set_up_rendering()


main()
