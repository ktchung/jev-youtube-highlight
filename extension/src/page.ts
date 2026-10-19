import { installDescriptionBridge } from './description';
import { videoIdFromUrl } from './content-core';

installDescriptionBridge(document, () => videoIdFromUrl(location.href));
