import React from 'react';
import { BaseBoxShapeTool } from 'tldraw';



class ScreenStreamShapeTool extends BaseBoxShapeTool {
    static id = 'ScreenStream';
    shapeType = 'ScreenStream';

    onSelect = () => {
        this.editor.setCurrentTool('ScreenStream');
    };
}

export const Main = ScreenStreamShapeTool;
