import React from 'react';
import { BaseBoxShapeTool } from 'tldraw';



class WidgetShapeTool extends BaseBoxShapeTool {
    static id = 'Widget';
    shapeType = 'Widget';

    onSelect = () => {
        this.editor.setCurrentTool('Widget');
    };
}

export const Main = WidgetShapeTool;
