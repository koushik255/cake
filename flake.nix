{
  description = "Cake media library server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        cake = pkgs.buildGoModule {
          pname = "cake";
          version = "0.1.0";
          src = ./.;
          vendorHash = null;
          subPackages = [ "cmd/cake" ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postInstall = ''
            wrapProgram $out/bin/cake \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg ]}
          '';
        };
      in
      {
        packages.default = cake;
        packages.cake = cake;

        apps.default = {
          type = "app";
          program = "${cake}/bin/cake";
        };
        apps.cake = self.outputs.apps.${system}.default;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.go
            pkgs.ffmpeg
          ];

          shellHook = ''
            echo "Cake dev shell"
            echo "  go run ./cmd/cake"
            echo "  go test ./..."
          '';
        };
      });
}
