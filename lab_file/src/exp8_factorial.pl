% Factorial using an accumulator (tail recursive)
fact(N, F) :-
    N >= 0,
    fact_acc(N, 1, F).

fact_acc(0, Acc, Acc) :- !.
fact_acc(N, Acc, F) :-
    Acc1 is Acc * N,
    N1 is N - 1,
    fact_acc(N1, Acc1, F).
