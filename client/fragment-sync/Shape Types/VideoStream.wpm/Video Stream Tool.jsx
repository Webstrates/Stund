import React from 'react';
import { BaseBoxShapeTool } from 'tldraw';



class VideoStreamShapeTool extends BaseBoxShapeTool {
    static id = 'VideoStream';
    shapeType = 'VideoStream';

    onSelect = () => {
        this.editor.setCurrentTool('VideoStream');
    };
}

export const Main = VideoStreamShapeTool;
