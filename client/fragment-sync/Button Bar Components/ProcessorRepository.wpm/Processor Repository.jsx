import { createFragmentRepository } from '#FragmentRepository .default';

export const Main = createFragmentRepository({
    type: 'processor',
    singular: 'Processor',
    plural: 'Processors',
    fallbackName: 'Unnamed Processor',
    icon: 'conversion_path',
    fragmentContainerId: 'processor-fragments',
    defaultRepositoryUrl: 'stund-processor-repository'
});
