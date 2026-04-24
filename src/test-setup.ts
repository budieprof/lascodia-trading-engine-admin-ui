// Ensures the Angular JIT compiler is available so partial-compiled classes
// in @angular/core and @angular/common can resolve their ɵɵngDeclareFactory
// calls during tests. Required because we don't run Angular's AOT linker here.
import '@angular/compiler';
