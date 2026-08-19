import { createFragmentRepository } from '#FragmentRepository .default';

export const Main = createFragmentRepository({
    type: 'widget',
    singular: 'Widget',
    plural: 'Widgets',
    fallbackName: 'Untitled Widget',
    icon: 'widgets',
    fragmentContainerId: 'widget-fragments',
    defaultRepositoryUrl: 'stund-widget-repository',
    shapeType: 'Widget'
});
