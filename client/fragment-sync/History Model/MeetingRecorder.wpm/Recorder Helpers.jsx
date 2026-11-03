import React from 'react';


// Clean up the shape data so the history models is cleaner and smaller
// https://tldraw.dev/reference/tlschema/TLBaseShape
export const cleanShapeData = (shape) => ({
    id: shape.id,
    type: shape.type,
    // typeName: shape.typeName, // Is always 'shape'

    x: shape.x,
    y: shape.y,
    rotation: shape.rotation,
    opacity: shape.opacity,

    // Not relevant for now
    // isLocked: shape.isLocked,
    // meta: shape.meta,
    // parentid: shape.parentId,
    // index: shape.index,

    props: {
        // Basic / Notes
        ...(shape.props?.color && { color: shape.props.color }),
        ...(shape.props?.richText && { richText: shape.props.richText }),
        // ...(shape.props?.size && { size: shape.props.size }),
        // ...(shape.props?.font && { font: shape.props.font }),
        // ...(shape.props?.align && { align: shape.props.align }),
        // ...(shape.props?.verticalAlign && { verticalAlign: shape.props.verticalAlign }),
        // ...(shape.props?.labelColor && { labelColor: shape.props.labelColor }),
        // ...(shape.props?.growY !== undefined && { growY: shape.props.growY }),
        // ...(shape.props?.fontSizeAdjustment !== undefined && { fontSizeAdjustment: shape.props.fontSizeAdjustment }),
        // ...(shape.props?.url !== undefined && { url: shape.props.url }),
        // ...(shape.props?.scale !== undefined && { scale: shape.props.scale }),

        // Text
        // ...(shape.props?.autoSize && { autoSize: shape.props.autoSize }),
        ...(shape.props?.w !== undefined && { w: shape.props.w }),

        // Geometric Shapes
        ...(shape.props?.h !== undefined && { h: shape.props.h }),
        // ...(shape.props?.geo !== undefined && { geo: shape.props.geo }),
        // ...(shape.props?.dash && { dash: shape.props.dash }),
        // ...(shape.props?.fill && { fill: shape.props.fill }),

        // Image
        ...(shape.props?.url && { url: shape.props.url }),
        ...(shape.props?.assetId && { assetId: shape.props.assetId }),
        // ...(shape.props?.playing !== undefined && { playing: shape.props.playing }),
        // ...(shape.props?.crop !== undefined && { crop: shape.props.crop }),
        // ...(shape.props?.flipX !== undefined && { flipX: shape.props.flipX }),
        // ...(shape.props?.flipY !== undefined && { flipY: shape.props.flipY }),
        // ...(shape.props?.altText !== undefined && { altText: shape.props.altText }),

        // Scribble
        // ...(shape.props?.points && { points: shape.props.points }),

        // Video and Screen Streams
        ...(shape.props?.client && { client: shape.props.client }),
        ...(shape.props?.userName && { userName: shape.props.userName }),

        // Documents own their Markdown, including intentionally empty text.
        ...(shape.type === 'Document' && { text: shape.props?.text ?? '' }),
        ...(shape.type === 'Document' && shape.props?.fontSize !== undefined && { fontSize: shape.props.fontSize }),

        // Widget
        ...(shape.props?.sourceFragmentId && { sourceFragmentId: shape.props.sourceFragmentId }),
        ...(shape.props?.name && { name: shape.props.name }),

        // ... add more props as needed
    },
});

export const cleanShapesData = (shapes) => {
    return shapes.map(shape => cleanShapeData(shape));
};
