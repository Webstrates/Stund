import React from 'react';
import { BaseBoxShapeTool } from 'tldraw';



class DocumentShapeTool extends BaseBoxShapeTool {
    static id = 'Document';
    shapeType = 'Document';

    onSelect = () => {
        this.editor.setCurrentTool('Document');
    };
}

export const Main = DocumentShapeTool;
