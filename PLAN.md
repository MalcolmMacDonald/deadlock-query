This is a website for writing queries about the Deadlock Map.
Deadlock is a 6v6 Third person MOBA made by Valve.

This website will be written in Typescript using Effect.ts, Bun, and hosted on Github Pages.
It will have a Development deployment that is only accessible via a password, which will give access to the Claude kanban for remote development.
It will be written using Claude, and each module will keep it's current development state/plans stored in a way that Claude can easily access.
If a module has a visual component in the website, it will be easily rearranged by the user.


The website is going to consist of many independent modules that will interact with each other.

Modules will use SemVer and change their major version number when API breaking changes are made, which will allow for modules to depend on each other.

Here is a list of currently planned modules:


3D viewer of the map file with camera controls and annotation tools for adding points of interest ontop of the map, like OpenStreetMap

A local-only command line for extracting the deadlock map files using Source2Viewer https://s2v.app/ for use in the 3D viewer

A local-only command line tool for instructing the Deadlock application to take screenshots at locations using Remote Console (rcon) commands

Query builder that lets the user write a line of C# with intellisense autocomplete.
The query builder is the main feature of the website. You should be able to see your query's results in the map and export them as various formats.
Some example queries include:
Healing orbs within 10 seconds of a lane's guardian
Pairs of wall positions that are twice as far via normal traversal as they are as the crow flies
Neutral creep camps that are visible from high locations

A set of premade C# libraries/functions for writing queries in the style of LINQ. eg. (NearestWall(), VisibleFrom(), IsInterior())

A dev-deployment-only kanban board for instructing Claude to write features remotely, using https://github.com/MalcolmMacDonald/github-kanban as a base.
The kanban board should have different sections for each module, and should allow for feedback on individual features.
Features from the kanban should only impact a single module at a time, allowing for simultaneous development.

A module for handling of the user-submitted map metadata info (eg. Walkable regions, neutral creep camp locations, sinners sacrifice locations)
This module will help the admin review the user submitted modifications and accept or reject them.




