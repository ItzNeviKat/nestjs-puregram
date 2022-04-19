import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef, ModulesContainer } from '@nestjs/core';
import { ExternalContextCreator } from '@nestjs/core/helpers/external-context-creator';
import { ParamMetadata } from '@nestjs/core/helpers/interfaces';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { Module } from '@nestjs/core/injector/module';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { HearConditions, HearManager } from '@puregram/hear';
import { SceneManager, StepScene } from '@puregram/scenes';
import { SessionManager } from '@puregram/session';
import { Middleware, NextMiddleware } from 'middleware-io';
import {
  Composer,
  Context,
  MessageContext,
  Telegram,
  UpdateType
} from 'puregram';
import { UpdateName } from 'puregram/lib/types';

import { ListenerHandlerType } from '../enums/listener-handler-type.enum';
import { TelegramContextType } from '../execution-context';
import { TelegramParamsFactory } from '../factories/telegram-params-factory';
import { ListenerMetadata, TelegramModuleOptions } from '../interfaces';
import {
  PARAM_ARGS_METADATA,
  TELEGRAM_HEAR_MANAGER,
  TELEGRAM_MODULE_OPTIONS,
  TELEGRAM_NAME,
  TELEGRAM_SCENE_MANAGER,
  TELEGRAM_SESSION_MANAGER
} from '../telegram.constants';

import { BaseExplorerService } from './base-explorer.service';
import { MetadataAccessorService } from './metadata-accessor.service';

@Injectable()
export class ListenersExplorerService
  extends BaseExplorerService
  implements OnModuleInit
{
  private readonly telegramParamsFactory: TelegramParamsFactory =
    new TelegramParamsFactory();

  private telegram!: Telegram;

  constructor(
    @Inject(TELEGRAM_HEAR_MANAGER)
    private readonly hearManager: HearManager<MessageContext>,
    @Inject(TELEGRAM_SESSION_MANAGER)
    private readonly sessionManager: SessionManager,
    @Inject(TELEGRAM_SCENE_MANAGER)
    private readonly sceneManager: SceneManager,
    @Inject(TELEGRAM_MODULE_OPTIONS)
    private readonly telegramOptions: TelegramModuleOptions,
    @Inject(TELEGRAM_NAME)
    private readonly telegramName: string,

    private readonly moduleRef: ModuleRef,
    private readonly metadataAccessor: MetadataAccessorService,
    private readonly metadataScanner: MetadataScanner,
    private readonly modulesContainer: ModulesContainer,
    private readonly externalContextCreator: ExternalContextCreator
  ) {
    super();
  }

  onModuleInit(): void {
    this.telegram = this.moduleRef.get<Telegram>(this.telegramName, {
      strict: false
    });

    const composer: Composer<Context> = Composer.builder();

    // add `before` middlewares
    this.telegramOptions.middlewaresBefore?.forEach(
      composer.use.bind(composer)
    );

    if (this.telegramOptions.useSessionManager !== false) {
      composer.use(this.sessionManager.middleware);
    }

    if (this.telegramOptions.useSceneManager !== false) {
      composer.use(this.sceneManager.middleware);
      composer.use(this.sceneManager.middlewareIntercept);
    }

    this.explore(composer);

    if (this.telegramOptions.useHearManager !== false) {
      composer.use(this.hearManager.middleware);
    }

    // add `after` middlewares
    this.telegramOptions.middlewaresAfter?.forEach(composer.use.bind(composer));

    // finally
    this.telegram.updates.use(composer.compose());
  }

  explore(composer: Composer<Context>): void {
    const modules: Module[] = this.getModules(
      this.modulesContainer,
      this.telegramOptions.include ?? []
    );

    this.registerUpdates(composer, modules);
    this.registerScenes(modules);
  }

  private registerUpdates(
    composer: Composer<Context>,
    modules: Module[]
  ): void {
    const updates: InstanceWrapper[] = this.flatMap(
      modules,
      (instance) => this.filterUpdates(instance)!
    );

    updates.forEach((wrapper) => this.registerListeners(composer, wrapper));
  }

  private filterUpdates(
    wrapper: InstanceWrapper
  ): InstanceWrapper<unknown> | undefined {
    const { instance } = wrapper;
    if (!instance) return;

    const isUpdate: boolean = this.metadataAccessor.isUpdate(wrapper.metatype);
    if (!isUpdate) return;

    return wrapper;
  }

  private registerScenes(modules: Module[]): void {
    const scenes: InstanceWrapper[] = this.flatMap(
      modules,
      (wrapper) => this.filterScenes(wrapper)!
    );

    scenes.forEach((wrapper) => this.registerScene(wrapper));
  }

  private filterScenes(
    wrapper: InstanceWrapper
  ): InstanceWrapper<unknown> | undefined {
    const { instance } = wrapper;
    if (!instance) return;

    const isScene: boolean = this.metadataAccessor.isScene(wrapper.metatype);
    if (!isScene) return;

    return wrapper;
  }

  private registerListeners(
    composer: Composer<Context>,
    wrapper: InstanceWrapper<Object>
  ): void {
    const { instance } = wrapper;
    const prototype: Object = Object.getPrototypeOf(instance);

    this.metadataScanner.scanFromPrototype(instance, prototype, (name) =>
      this.registerIfListener(composer, instance, prototype, name)
    );
  }

  private registerScene(wrapper: InstanceWrapper): void {
    const { instance } = wrapper;
    const prototype: Object = Object.getPrototypeOf(instance);

    const slug: string | undefined = this.metadataAccessor.getSceneMetadata(
      wrapper.instance.constructor
    );
    if (!slug) return;

    const steps: [number, string][] = [];

    let currentStep: number = 0;
    let enterHandler: StepScene['enterHandler'] | undefined;
    let leaveHandler: StepScene['leaveHandler'] | undefined;

    this.metadataScanner.scanFromPrototype(instance, prototype, (method) => {
      const target: Function = prototype[method as keyof typeof prototype];

      const action: 'enter' | 'leave' | undefined =
        this.metadataAccessor.getSceneActionMetadata(target);

      switch (action) {
        case 'enter':
          enterHandler = this.createContextCallback(
            instance,
            prototype,
            method
          );
          break;

        case 'leave':
          leaveHandler = this.createContextCallback(
            instance,
            prototype,
            method
          );
          break;
      }

      const step: number =
        this.metadataAccessor.getSceneStepMetadata(target) ?? currentStep++;

      steps.push([step, method]);
    });

    const scene: StepScene<MessageContext> = new StepScene(slug, {
      enterHandler,
      leaveHandler,
      steps: steps
        .sort(([a], [b]) => a - b)
        .map(([, method]) =>
          this.createContextCallback(instance, prototype, method)
        )
    });

    this.sceneManager.addScenes([scene]);
  }

  private registerIfListener(
    composer: Composer<Context>,
    instance: Object,
    prototype: Object,
    method: string
  ): void {
    const target: Function = prototype[method as keyof typeof prototype];

    const metadata: ListenerMetadata[] | undefined =
      this.metadataAccessor.getListenerMetadata(target);
    if (!metadata || metadata.length < 1) return;

    const listenerCallbackFn = this.createContextCallback(
      instance,
      prototype,
      method
    );

    for (const listener of metadata) {
      const { type, args } = listener;

      const handler: Middleware<Context> = async (
        ctx: Context,
        next: NextMiddleware
      ): Promise<void> => {
        const result: unknown = await listenerCallbackFn(ctx, next);

        if (ctx.is(['message'])) {
          if (typeof result === 'string') {
            if (this.telegramOptions.notReplyMessage) {
              await (ctx as MessageContext).send(result);
            } else {
              await (ctx as MessageContext).reply(result);
            }
          }
        }

        // TODO-Possible-Feature: Add more supported return types
      };

      switch (type) {
        case ListenerHandlerType.USE:
          composer.use(handler);
          break;

        case ListenerHandlerType.ON:
          const update: UpdateType | UpdateName | undefined = args[0] as
            | UpdateType
            | UpdateName;
          if (!update) break;

          const middlewares: Middleware<Context>[] =
            (args[1] as Middleware<Context>[]) ?? [];

          composer.use((context: Context, next: NextMiddleware) => {
            if (context.is([update])) {
              const handlerComposer: Composer<Context> = new Composer();
              [
                ...(Array.isArray(middlewares) ? middlewares : [middlewares]),
                handler
              ].forEach(handlerComposer.use.bind(handlerComposer));

              const finalHandler: Middleware<Context> =
                handlerComposer.compose();

              return finalHandler(context, next);
            }

            return next();
          });
          break;

        case ListenerHandlerType.HEARS:
          const hearConditions: HearConditions<unknown> | undefined =
            args[0] as HearConditions<unknown>;
          if (!hearConditions) break;

          this.hearManager.hear(hearConditions, handler);
          break;

        case ListenerHandlerType.HEAR_FALLBACK:
          this.hearManager.onFallback(handler);
          break;
      }
    }
  }

  createContextCallback(instance: Object, prototype: Object, method: string) {
    const paramsFactory: TelegramParamsFactory = this.telegramParamsFactory;

    const callback: (...args: unknown[]) => unknown = prototype[
      method as keyof typeof prototype
    ] as (...args: unknown[]) => unknown;

    const resolverCallback = this.externalContextCreator.create<
      Record<number, ParamMetadata>,
      TelegramContextType
    >(
      instance,
      callback,
      method,
      PARAM_ARGS_METADATA,
      paramsFactory,
      undefined,
      undefined,
      undefined,
      'telegram'
    );
    return resolverCallback;
  }
}
