import { HearConditions } from '@puregram/hear';

import { ListenerHandlerType } from '../../enums/listener-handler-type.enum';
import { createListenerDecorator } from '../../utils';

export const Hears = (hearConditions: HearConditions<any>) =>
  createListenerDecorator(ListenerHandlerType.HEARS, hearConditions);

export const HearFallback = () =>
  createListenerDecorator(ListenerHandlerType.HEAR_FALLBACK);
