% Fibonacci sequence 0, 1, 1, 2, 3, 5, 8, ...
% fib_list(N, L) : L holds the first N terms
fib_list(N, L) :-
    N >= 1,
    fib_build(N, 0, 1, L).

fib_build(0, _, _, []) :- !.
fib_build(N, A, B, [A|T]) :-
    C is A + B,
    N1 is N - 1,
    fib_build(N1, B, C, T).

% nth_fib(N, F) : F is the Nth term (1st term = 0)
nth_fib(N, F) :-
    fib_list(N, L),
    last(L, F).

% print the series in a readable form
show_fib(N) :-
    fib_list(N, L),
    atomic_list_concat(L, ', ', S),
    format("First ~w terms : ~w~n", [N, S]).
