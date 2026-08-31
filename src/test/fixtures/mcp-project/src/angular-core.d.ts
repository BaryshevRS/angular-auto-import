declare module "@angular/core" {
  export function Component(options: Record<string, unknown>): ClassDecorator;

  export interface InputSignal<T> {
    (): T;
  }

  export interface InputFunction {
    required<T>(options?: { alias?: string }): InputSignal<T>;
  }

  export const input: InputFunction;
  export function output<T>(): { emit(value: T): void };
}
