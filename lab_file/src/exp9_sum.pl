% Sum of first N natural numbers: 1 + 2 + ... + N
sum_n(0, 0) :- !.
sum_n(N, S) :-
    N > 0,
    N1 is N - 1,
    sum_n(N1, S1),
    S is S1 + N.

% check the answer against the formula N(N+1)/2
verify(N) :-
    sum_n(N, S),
    F is N * (N + 1) // 2,
    format("Recursive sum = ~w, Formula = ~w~n", [S, F]).
