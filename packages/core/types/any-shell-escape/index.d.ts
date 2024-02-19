declare module 'any-shell-escape' {
    export function msg(x: (string | string[])[]): string;

    export default function (stringOrArray: (string | string[])[]): string;
}
