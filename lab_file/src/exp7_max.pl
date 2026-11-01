% Maximum of two numbers
max_of_two(X, Y, Max) :-
    (   X >= Y
    ->  Max = X
    ;   Max = Y
    ).

% Maximum of three numbers (reuses max_of_two)
max_of_three(X, Y, Z, Max) :-
    max_of_two(X, Y, T),
    max_of_two(T, Z, Max).
