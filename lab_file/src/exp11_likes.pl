% Knowledge base
% Rule : Prakash likes food if the food is edible and tastes sweet
likes(prakash, Food) :-
    edible(Food),
    tastes(Food, sweet).

% Facts about taste
tastes(chocolates, sweet).
tastes(toffees, sweet).
tastes(gourd, bitter).

% Facts about edibility
edible(chocolates).
edible(toffees).
edible(gourd).
